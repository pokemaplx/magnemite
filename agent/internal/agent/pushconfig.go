package agent

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"magnemite/agent/internal/deviceconfig"
	"magnemite/agent/internal/proto"
)

// How long each hook gets. They only stop and start an app, so this is a
// ceiling on a wedged command rather than a budget -- the same one the
// installer gives its post-install hook.
const configHookTimeout = 2 * time.Minute

// pushConfig rewrites a MITM's config on a running box with nothing installed:
// the pre-install hook stops what reads the file, the file is written exactly
// as an install writes it, and the post-install hook starts it again on the
// new settings.
//
// The content is never logged. It holds the MITM's credentials, and keeping
// them out of every log is the reason this is a message at all rather than a
// command typed into Execute.
func (a *Agent) pushConfig(msg proto.PushConfig) {
	result := proto.PushConfigResult{Type: "push_config_result", RequestID: msg.RequestID}

	// One at a time: two pushes interleaved would each restart the scanner in
	// the middle of the other's stop and start.
	if !a.pushMu.TryLock() {
		result.Error = "a config push is already running on this box"
		_ = a.send(result)
		return
	}
	defer a.pushMu.Unlock()

	// Not under an install either. The installer writes this same file between
	// these same hooks, and the two interleaved can leave the scanner stopped.
	// The hub checks before sending; this is the box's own word on it.
	if running := a.currentJob(); running != "" {
		result.Error = "an install is running on this box (job " + running + "); try again once it has finished"
		_ = a.send(result)
		return
	}

	log.Printf("push config: rewriting %s", msg.Config.Path)

	var hookErrors []string
	if err := a.runConfigHook(msg.PreHook); err != nil {
		hookErrors = append(hookErrors, "stop: "+err.Error())
	}

	res, err := deviceconfig.Apply(a.Sys, msg.Config, a.ConfigPath)
	if err != nil {
		result.Error = err.Error()
	} else {
		result.OK = true
		result.SHA256 = res.SHA256
	}

	// Run even when the write failed: the stop above already happened, and a
	// scanner left stopped is worse than one started again on the config it
	// had before.
	if err := a.runConfigHook(msg.PostHook); err != nil {
		hookErrors = append(hookErrors, "start: "+err.Error())
	}
	result.HookError = strings.Join(hookErrors, "; ")

	switch {
	case !result.OK:
		log.Printf("push config: %s not written: %s", msg.Config.Path, result.Error)
	case result.HookError != "":
		log.Printf("push config: wrote %s (sha256 %s), but %s", msg.Config.Path, short(result.SHA256), result.HookError)
	default:
		log.Printf("push config: wrote %s (sha256 %s)", msg.Config.Path, short(result.SHA256))
	}
	_ = a.send(result)
}

// runConfigHook runs one of the group's hooks around a push. Empty is nothing
// to run. Its own context, like the installer's hooks, so a slow stop cannot
// eat the start's time.
func (a *Agent) runConfigHook(hook string) error {
	hook = strings.TrimSpace(hook)
	if hook == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), configHookTimeout)
	defer cancel()

	out, err := a.Sys.Shell(ctx, hook)
	if err != nil {
		if detail := strings.TrimSpace(truncateOutput(out)); detail != "" {
			return fmt.Errorf("%v: %s", err, detail)
		}
		return err
	}
	return nil
}

func short(sum string) string {
	if len(sum) > 12 {
		return sum[:12]
	}
	return sum
}
