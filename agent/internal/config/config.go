package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Config lives at /data/adb/magnemite/config.json on a real box — inside the
// Magisk data directory, which survives app wipes and factory-reset-lite.
type Config struct {
	ServerURL string `json:"serverUrl"`
	// Shared secret used once, to trade for a device token.
	EnrollmentToken string `json:"enrollmentToken,omitempty"`
	DeviceToken     string `json:"deviceToken,omitempty"`
	DeviceID        string `json:"deviceId,omitempty"`
	Name            string `json:"name,omitempty"`
	// Scratch space for bundles and extracted splits.
	WorkDir string `json:"workDir,omitempty"`
	// Serial to report instead of the one the box knows about. The hub keys a
	// device on its serial alone, and a container has no stable ro.serialno —
	// without this it would fall back to a MAC that changes on every recreate
	// and earn a new row in the Devices table each time.
	Serial string `json:"serial,omitempty"`
	// What a reboot from the hub actually runs. Empty means `reboot`, which is
	// what a box with its own kernel wants. A container has no kernel of its
	// own to restart, so it points this at a framework restart instead.
	RebootCommand string `json:"rebootCommand,omitempty"`
}

const DefaultPath = "/data/adb/magnemite/config.json"
const DefaultWorkDir = "/data/local/tmp/magnemite"

func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if c.WorkDir == "" {
		c.WorkDir = DefaultWorkDir
	}
	return &c, nil
}

func (c *Config) Save(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	// Write then rename: a box losing power mid-write must not come back with
	// a truncated config and no way to reach the server.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
