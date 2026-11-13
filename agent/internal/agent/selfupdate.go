package agent

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"

	"magnemite/agent/internal/fetch"
	"magnemite/agent/internal/proto"
)

// selfUpdate replaces the running binary and re-executes it.
//
// The swap is a rename, which is atomic on the same filesystem: a box losing
// power mid-update comes back running either the old agent or the new one,
// never a half-written file. That matters because a bricked agent on a box in
// someone's living room is a physical trip to fix.
// updateFailed tells the hub why the swap did not happen. Best effort: a box
// whose socket just died still logs locally and simply gets told to update
// again on the next hello.
func (a *Agent) updateFailed(version string, format string, args ...any) {
	reason := fmt.Sprintf(format, args...)
	log.Printf("self-update: %s", reason)
	_ = a.send(proto.AgentUpdateResult{
		Type:    "agent_update_result",
		Version: version,
		OK:      false,
		Error:   reason,
	})
}

func (a *Agent) selfUpdate(msg proto.AgentUpdate) {
	if msg.Version == a.Version {
		log.Printf("self-update: already on %s", msg.Version)
		return
	}
	// Never swap the binary out from under a running install. Not a failure:
	// the hub sees this box again on the next sweep and tries then.
	if a.currentJob() != "" {
		log.Printf("self-update to %s deferred: a job is running", msg.Version)
		return
	}

	exe, err := os.Executable()
	if err != nil {
		a.updateFailed(msg.Version, "cannot find own path: %v", err)
		return
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		a.updateFailed(msg.Version, "%v", err)
		return
	}

	log.Printf("self-update: downloading %s", msg.Version)
	tmp := exe + ".new"
	if err := a.downloadBinary(msg, tmp); err != nil {
		a.updateFailed(msg.Version, "download failed: %v", err)
		os.Remove(tmp)
		return
	}

	if err := os.Chmod(tmp, 0o755); err != nil {
		a.updateFailed(msg.Version, "chmod failed: %v", err)
		os.Remove(tmp)
		return
	}

	// Keep the old binary next to the new one: if the replacement cannot
	// start, service.sh can put this back.
	backup := exe + ".old"
	os.Remove(backup)
	if err := os.Rename(exe, backup); err != nil {
		a.updateFailed(msg.Version, "cannot move current binary: %v", err)
		os.Remove(tmp)
		return
	}
	if err := os.Rename(tmp, exe); err != nil {
		a.updateFailed(msg.Version, "cannot install new binary: %v", err)
		os.Rename(backup, exe)
		return
	}

	log.Printf("self-update: restarting into %s", msg.Version)
	if err := execSelf(exe, os.Args, os.Environ()); err != nil {
		// Exec only returns on failure. Fall back to spawning a child and
		// exiting, which the Magisk service loop also handles.
		log.Printf("self-update: exec failed (%v), respawning", err)
		cmd := exec.Command(exe, os.Args[1:]...)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if serr := cmd.Start(); serr != nil {
			log.Printf("self-update: respawn failed: %v", serr)
			return
		}
		os.Exit(0)
	}
}

func (a *Agent) downloadBinary(msg proto.AgentUpdate, dest string) error {
	// 0755 because what lands here is the binary this process will exec.
	return fetch.Verified(context.Background(), msg.URL, a.Cfg.DeviceToken, msg.SHA256, dest, 0o755)
}
