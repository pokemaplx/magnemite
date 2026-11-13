// Package fetch downloads a file the hub published and proves it is the one
// the hub meant.
//
// Extracted rather than written: the self-update already did exactly this,
// and the installer does a resumable variant of it. A third copy for the box
// enrollment would have been the point where a fix stops reaching all of
// them.
package fetch

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

// DefaultTimeout is generous because what travels this way is measured in
// megabytes over whatever connection a box in a living room has.
const DefaultTimeout = 10 * time.Minute

// Verified downloads url to dest and fails unless it hashes to want.
//
// The hash is computed while the bytes are written rather than by reading the
// file back: the point is to catch a truncated or swapped download, and a
// second read would only prove the disk agrees with itself.
//
// A failed download leaves dest in whatever state it reached. Every caller
// either writes to a temporary name or overwrites on the next attempt, and
// cleaning up here would hide which of the two happened.
func Verified(ctx context.Context, url, token, want, dest string, mode os.FileMode) error {
	ctx, cancel := context.WithTimeout(ctx, DefaultTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	// Every artifact route is behind the device's own token, including the
	// static one the edge serves without Node in the path.
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(out, h), resp.Body); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	out.Close()

	// O_CREATE only applies the mode when it creates the file, and these are
	// all paths that get written over.
	if err := os.Chmod(dest, mode); err != nil {
		return err
	}

	sum := hex.EncodeToString(h.Sum(nil))
	if sum != want {
		return fmt.Errorf("checksum mismatch: expected %s, got %s", want, sum)
	}
	return nil
}
