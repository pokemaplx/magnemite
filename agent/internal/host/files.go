package host

import "os"

// Small helpers, local to this package so it does not reach into sys for them.
// Both treat an unreadable path as absent rather than as an error: everything
// they read is optional, and a machine that cannot say is a real answer the hub
// knows how to store.

func readFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
