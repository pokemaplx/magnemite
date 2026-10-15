package agent

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"magnemite/agent/internal/logs"
	"magnemite/agent/internal/proto"
)

// One look at what is on the box's screen, when the hub asks for one.
//
// Every other thing this agent reports is a number. This is the one that
// answers what a number cannot: a box can be heartbeating, with the scanner's
// process alive, sitting on a dialog nobody has read.
//
// The PNG travels the log bundle's road -- captured to a file, posted over
// HTTP with the device token, deleted -- because a socket frame is capped at
// 1 MB and a 1080p capture is regularly more than that.

// How long the whole capture-and-upload is given. A `screencap` is quick; the
// upload is a megabyte or two over whatever uplink the box has.
const screenshotTimeout = 45 * time.Second

// The first eight bytes of any PNG.
//
// Checked because `screencap` is not reliably loud about failing: on a box
// with no display service it can exit 0 having written nothing, or having
// written an error message where the image should be. Both would otherwise
// reach the dashboard as a broken image with no explanation, which is the
// least useful of the three possible outcomes.
var pngMagic = []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a}

func (a *Agent) collectScreenshot(msg proto.CollectScreenshot) {
	ctx, cancel := context.WithTimeout(context.Background(), screenshotTimeout)
	defer cancel()

	workDir := a.Cfg.WorkDir
	if workDir == "" {
		workDir = os.TempDir()
	}
	path := filepath.Join(workDir, "magnemite-shot-"+msg.ScreenshotID+".png")
	// The image is a courier, not an artifact: the hub keeps it, the box does
	// not. A box in someone's living room does not accumulate pictures of
	// itself because an upload failed.
	defer os.Remove(path)

	if err := a.capture(ctx, path); err != nil {
		a.reportScreenshotFailure(msg.ScreenshotID, err.Error())
		return
	}

	if err := logs.UploadFile(ctx, msg.UploadURL, a.Cfg.DeviceToken, path, "image/png", "/api/screenshots/*"); err != nil {
		a.reportScreenshotFailure(msg.ScreenshotID, "could not upload the screenshot: "+err.Error())
		return
	}

	// No success frame: the upload landing is the hub's proof.
	log.Printf("screenshot: %s uploaded", msg.ScreenshotID)
}

// capture writes one PNG at path, or says why it could not.
//
// `screencap -p` rather than the raw framebuffer: the raw form is ~8 MB of
// RGBA at 1080p and would have to be encoded here, on a CPU that has a scanner
// to run. Letting Android do it costs one process and hands back something a
// browser can already display.
func (a *Agent) capture(ctx context.Context, path string) error {
	// Quoted, even though the path is built from a cuid and a work directory
	// that cannot contain a space today, because the one that eventually does
	// would fail as a baffling "screencap: not found".
	if out, err := a.Sys.Shell(ctx, "screencap -p "+shellQuote(path)); err != nil {
		// A ROM without screencap, a display service that is not up, or a
		// container whose image has no virtual display. The box's own words
		// are more use here than anything this function could guess.
		return fmt.Errorf("screencap failed: %s", trimTo(out, 200))
	}

	stat, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("screencap wrote nothing: %w", err)
	}
	if stat.Size() == 0 {
		return fmt.Errorf("screencap wrote an empty file — this box has no display to capture")
	}

	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	head := make([]byte, len(pngMagic))
	if _, err := file.Read(head); err != nil {
		return fmt.Errorf("could not read the capture back: %w", err)
	}
	if !bytes.Equal(head, pngMagic) {
		// Almost always an error message sitting where the image should be, so
		// it is worth quoting rather than describing.
		return fmt.Errorf("screencap did not produce a PNG: %s", trimTo(string(head), 64))
	}
	return nil
}

func (a *Agent) reportScreenshotFailure(screenshotID, reason string) {
	log.Printf("screenshot: %s", reason)
	_ = a.send(proto.ScreenshotResult{
		Type:         "screenshot_result",
		ScreenshotID: screenshotID,
		OK:           false,
		Error:        reason,
	})
}

// trimTo keeps a quoted failure readable in a dialog. `screencap` on a wedged
// box can print a great deal.
func trimTo(s string, max int) string {
	if len(s) > max {
		return s[:max] + "…"
	}
	return s
}

// shellQuote is the installer's, duplicated rather than exported from there:
// four lines, and a `logs`-style package shared between the two would exist
// only to hold it.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
