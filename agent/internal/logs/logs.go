// Package logs collects what a box wrote, so nobody has to go to the box.
//
// Two jobs. Bundle zips a snapshot — the logcat tail plus the agent's own log
// — for the dashboard to download. Stream runs logcat live and hands batches
// of lines back, for as long as someone is watching.
package logs

import (
	"archive/zip"
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"magnemite/agent/internal/sys"
)

// Where the agent's own log is kept: the Magisk service.sh writes it on a box,
// magnemite-start.sh inside a Redroid container. The agent only ever reads it.
const (
	dataDir     = "/data/adb/magnemite"
	agentLog    = dataDir + "/agent.log"
	agentLogOld = dataDir + "/agent.log.1"
)

// Collecting is a handful of shell calls; a box this slow is broken anyway.
const collectTimeout = 2 * time.Minute

// Bundle writes a zip of the box's logs to destPath.
//
// Deflated, unlike the .apkm wrapper elsewhere in the agent: this is text, and
// a logcat tail compresses to a fraction of itself — which matters on a box
// uploading over someone's home connection.
func Bundle(ctx context.Context, system sys.System, agentVersion, destPath string, maxLines int) error {
	ctx, cancel := context.WithTimeout(ctx, collectTimeout)
	defer cancel()

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return err
	}
	file, err := os.Create(destPath)
	if err != nil {
		return err
	}
	defer file.Close()

	archive := zip.NewWriter(file)

	// logcat first: it is the reason anyone asked. A box with no logcat (or a
	// permission problem) still gets a bundle, with the error in its place —
	// more useful than no bundle at all.
	logcat, err := system.Exec(ctx, "logcat", "-d", "-v", "time", "-t", fmt.Sprint(maxLines))
	if err != nil {
		logcat = fmt.Sprintf("logcat failed: %v\n\n%s", err, logcat)
	}
	if err := writeEntry(archive, "logcat.txt", []byte(logcat)); err != nil {
		return err
	}

	for _, source := range []struct{ name, path string }{
		{"agent.log", agentLog},
		{"agent.log.1", agentLogOld},
	} {
		data, err := os.ReadFile(source.path)
		if err != nil {
			// The rotated one usually does not exist; that is not a failure.
			continue
		}
		if err := writeEntry(archive, source.name, data); err != nil {
			return err
		}
	}

	if err := writeEntry(archive, "device.txt", []byte(deviceSummary(ctx, system, agentVersion))); err != nil {
		return err
	}

	if err := archive.Close(); err != nil {
		return err
	}
	return file.Sync()
}

func writeEntry(archive *zip.Writer, name string, data []byte) error {
	entry, err := archive.CreateHeader(&zip.FileHeader{
		Name:     name,
		Method:   zip.Deflate,
		Modified: time.Now(),
	})
	if err != nil {
		return err
	}
	_, err = entry.Write(data)
	return err
}

// deviceSummary is the context that makes a log readable a week later: which
// box this was, what it was running, and whether it had any disk left.
func deviceSummary(ctx context.Context, system sys.System, agentVersion string) string {
	info := system.DeviceInfo(ctx)
	free, total, _ := system.Disk("/data")
	one, five, fifteen := system.LoadAvg()
	memTotal, memAvailable := system.Memory()

	var out bytes.Buffer
	fmt.Fprintf(&out, "collected     %s\n", time.Now().Format(time.RFC3339))
	fmt.Fprintf(&out, "serial        %s\n", info.Serial)
	fmt.Fprintf(&out, "manufacturer  %s\n", info.Manufacturer)
	fmt.Fprintf(&out, "model         %s\n", info.Model)
	fmt.Fprintf(&out, "android       %s (sdk %d)\n", info.AndroidVersion, info.SdkInt)
	fmt.Fprintf(&out, "abi           %s\n", info.Abi)
	fmt.Fprintf(&out, "density       %d\n", info.Density)
	fmt.Fprintf(&out, "local ip      %s\n", info.LocalIp)
	fmt.Fprintf(&out, "agent         %s\n", agentVersion)
	fmt.Fprintf(&out, "uptime        %ds\n", system.UptimeSeconds())
	fmt.Fprintf(&out, "/data         %d free of %d bytes\n", free, total)
	fmt.Fprintf(&out, "memory        %d available of %d bytes\n", memAvailable, memTotal)
	fmt.Fprintf(&out, "load          %.2f %.2f %.2f over %d cpus\n", one, five, fifteen, system.CPUCount())

	if packages, err := system.ThirdPartyPackages(ctx); err == nil {
		out.WriteString("\npackages\n")
		for _, pkg := range packages {
			fmt.Fprintf(&out, "  %s %s (%s)\n", pkg.PackageName, pkg.VersionName, pkg.VersionCode)
		}
	}

	// config.json is deliberately not in the bundle: it holds the device token.
	return out.String()
}

// Upload PUTs the bundle at url, authenticated with the device token — the
// same bearer the agent uses for artifact downloads.
func Upload(ctx context.Context, url, deviceToken, path string) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		return err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, file)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+deviceToken)
	req.Header.Set("Content-Type", "application/zip")
	req.ContentLength = stat.Size()

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("HTTP %d: %s%s", resp.StatusCode, strings.TrimSpace(string(body)), hint(resp.StatusCode))
	}
	return nil
}

// hint turns the two failures that are really deployment problems into
// something the person reading the dashboard can act on. A box saying "404"
// tells you nothing; "the edge is not routing this" tells you where to look.
func hint(status int) string {
	switch status {
	case http.StatusNotFound:
		return " — the reverse proxy in front of the hub is not routing POST /api/logs/*, " +
			"so the upload never reached it (see the Caddyfile)"
	case http.StatusUnauthorized:
		return " — the hub rejected this box's device token"
	default:
		return ""
	}
}

// Batching for the live stream. A busy box writes thousands of lines a second
// and one frame each would be the socket's entire budget, so lines are sent in
// batches; when even that cannot keep up, the oldest are dropped and counted.
const (
	batchInterval = time.Second
	batchLines    = 200
	maxBuffered   = 2000
)

// Stream follows a log until ctx is cancelled, calling emit with each batch.
// An empty path means logcat; anything else is a file the app writes itself.
//
// emit is called from this goroutine and must not block for long: whatever it
// waits on, the box keeps logging into a buffer that only has room for
// maxBuffered lines before it starts dropping.
func Stream(
	ctx context.Context,
	system sys.System,
	path string,
	emit func(lines []string, dropped int),
) error {
	var reader io.ReadCloser
	var err error
	if path == "" {
		reader, err = system.LogcatStream(ctx)
	} else {
		reader, err = system.FileStream(ctx, path)
	}
	if err != nil {
		return err
	}
	defer reader.Close()

	incoming := make(chan string, maxBuffered)
	readErr := make(chan error, 1)
	// Written by the reader, read by the batcher: the two run concurrently and
	// this is the only thing they share besides the channel.
	var droppedCount atomic.Int64

	go func() {
		defer close(incoming)
		scanner := bufio.NewScanner(reader)
		// A stack trace line can be long; the default 64 KB token is plenty,
		// but the default buffer is not.
		scanner.Buffer(make([]byte, 0, 8*1024), 512*1024)
		for scanner.Scan() {
			select {
			case incoming <- scanner.Text():
			default:
				// Buffer full: the box logs faster than the socket drains.
				// Dropping keeps the read loop moving, and the count tells the
				// dashboard it is not seeing everything.
				droppedCount.Add(1)
			}
			if ctx.Err() != nil {
				return
			}
		}
		readErr <- scanner.Err()
	}()

	ticker := time.NewTicker(batchInterval)
	defer ticker.Stop()

	batch := make([]string, 0, batchLines)

	flush := func() {
		dropped := int(droppedCount.Swap(0))
		if len(batch) == 0 && dropped == 0 {
			return
		}
		emit(batch, dropped)
		batch = make([]string, 0, batchLines)
	}

	for {
		select {
		case <-ctx.Done():
			flush()
			return nil

		case err := <-readErr:
			flush()
			return err

		case line, ok := <-incoming:
			if !ok {
				flush()
				return nil
			}
			if len(batch) >= batchLines {
				flush()
			}
			batch = append(batch, line)

		case <-ticker.C:
			flush()
		}
	}
}
