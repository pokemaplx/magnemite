package cosmog

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func zipBytes(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, content := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zipFile(t *testing.T, files map[string]string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "bundle.zip")
	if err := os.WriteFile(p, zipBytes(t, files), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func read(t *testing.T, p string) string {
	t.Helper()
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read %s: %v", p, err)
	}
	return string(data)
}

func TestInstallBundle(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cos")
	bundle := zipFile(t, map[string]string{
		Binary:            "ELF",
		"lib/libart.so":   "art",
		"lib/libextra.so": "extra",
		"config.toml":     "someone else's secrets",
	})

	if got := Version(dir); got != "" {
		t.Fatalf("version before any install = %q", got)
	}
	if _, err := InstallBundle(bundle, dir, "2.1.3"); err != nil {
		t.Fatal(err)
	}

	if got := read(t, filepath.Join(dir, Binary)); got != "ELF" {
		t.Errorf("binary = %q", got)
	}
	if got := read(t, filepath.Join(dir, "lib", "libart.so")); got != "art" {
		t.Errorf("libart = %q", got)
	}
	// A file this agent has never heard of still comes along.
	if got := read(t, filepath.Join(dir, "lib", "libextra.so")); got != "extra" {
		t.Errorf("extra lib = %q", got)
	}
	// The config is the hub's to write, and a bundle must not bring its own.
	if _, err := os.Stat(filepath.Join(dir, "config.toml")); err == nil {
		t.Error("the bundle's config.toml was unpacked")
	}
	if got := Version(dir); got != "2.1.3" {
		t.Errorf("version = %q", got)
	}
}

func TestInstallBundleKeepsTheConfigAndReplacesTheRest(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cos")
	first := zipFile(t, map[string]string{Binary: "old", "lib/libart.so": "old-art"})
	if _, err := InstallBundle(first, dir, "2.1.2"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte("mine"), 0o644); err != nil {
		t.Fatal(err)
	}

	second := zipFile(t, map[string]string{
		Binary: "new", "lib/libart.so": "new-art", "config.toml": "theirs",
	})
	if _, err := InstallBundle(second, dir, "2.1.3"); err != nil {
		t.Fatal(err)
	}

	if got := read(t, filepath.Join(dir, Binary)); got != "new" {
		t.Errorf("binary = %q", got)
	}
	if got := read(t, filepath.Join(dir, "lib", "libart.so")); got != "new-art" {
		t.Errorf("libart = %q", got)
	}
	if got := read(t, filepath.Join(dir, "config.toml")); got != "mine" {
		t.Errorf("config = %q, the install overwrote it", got)
	}
	if got := Version(dir); got != "2.1.3" {
		t.Errorf("version = %q", got)
	}
	// Nothing half-written left behind for Cosmog to trip over.
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("left %s behind", e.Name())
		}
	}
}

func TestInstallBundleInsideOneDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cos")
	bundle := zipFile(t, map[string]string{
		"cosmog/" + Binary:     "ELF",
		"cosmog/lib/libart.so": "art",
		"__MACOSX/._something": "junk",
	})
	if _, err := InstallBundle(bundle, dir, "2.1.3"); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dir, "lib", "libart.so")); got != "art" {
		t.Errorf("libart = %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "__MACOSX")); err == nil {
		t.Error("unpacked what was outside the bundle's own directory")
	}
}

func TestInstallBundleRefusals(t *testing.T) {
	cases := map[string]map[string]string{
		"no libart":   {Binary: "ELF"},
		"no binary":   {"lib/libart.so": "art"},
		"an apk":      {"AndroidManifest.xml": "x", "classes.dex": "y"},
		"too deep":    {"a/b/" + Binary: "ELF", "a/b/lib/libart.so": "art"},
		"leaves it":   {Binary: "ELF", "lib/libart.so": "art", "../escape": "x"},
		"leaves it 2": {Binary: "ELF", "lib/libart.so": "art", "lib/../../escape": "x"},
	}
	for name, files := range cases {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			dir := filepath.Join(root, "cos")
			if _, err := InstallBundle(zipFile(t, files), dir, "2.1.3"); err == nil {
				t.Fatal("installed")
			}
			if _, err := os.Stat(filepath.Join(root, "escape")); err == nil {
				t.Error("wrote outside the directory")
			}
			if got := Version(dir); got != "" {
				t.Errorf("a refused bundle reports version %q", got)
			}
		})
	}
}

func TestVersionNeedsTheBinary(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "cos.version"), []byte("2.1.3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := Version(dir); got != "" {
		t.Errorf("version = %q with no binary there", got)
	}
}

func TestInstallGame(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cos")
	split := zipBytes(t, map[string]string{
		"lib/arm64-v8a/libNianticLabsPlugin.so": "plugin",
		"lib/arm64-v8a/libother.so":             "other",
	})
	bundle := zipFile(t, map[string]string{
		"base.apk":                     string(zipBytes(t, map[string]string{"classes.dex": "dex"})),
		"split_config.arm64_v8a.apk":   string(split),
		"split_config.armeabi_v7a.apk": "not ours",
		"split_config.en.apk":          "strings",
		"info.json":                    "{}",
	})

	if got := GameVersion(dir); got != "" {
		t.Fatalf("game version before any install = %q", got)
	}
	if err := InstallGame(bundle, dir, "arm64-v8a", "0.377.1"); err != nil {
		t.Fatal(err)
	}

	if got := read(t, filepath.Join(dir, "lib", "libNianticLabsPlugin.so")); got != "plugin" {
		t.Errorf("plugin lib = %q", got)
	}
	for _, name := range []string{"base.apk", "split_config.arm64_v8a.apk"} {
		if _, err := os.Stat(filepath.Join(dir, "files", name)); err != nil {
			t.Errorf("files/%s: %v", name, err)
		}
	}
	// Only what Cosmog reads: not the other ABI, not the language split.
	entries, _ := os.ReadDir(filepath.Join(dir, "files"))
	if len(entries) != 2 {
		t.Errorf("files/ holds %d entries, want 2", len(entries))
	}
	if got := GameVersion(dir); got != "0.377.1" {
		t.Errorf("game version = %q", got)
	}
	// And it is not a Cosmog install on its own.
	if got := Version(dir); got != "" {
		t.Errorf("cosmog version = %q from a game install", got)
	}
}

func TestInstallGameFromASingleApk(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cos")
	apk := zipBytes(t, map[string]string{"lib/arm64-v8a/libNianticLabsPlugin.so": "plugin"})
	bundle := zipFile(t, map[string]string{"pokemongo.apk": string(apk)})

	if err := InstallGame(bundle, dir, "", "0.377.1"); err != nil {
		t.Fatal(err)
	}
	if got := read(t, filepath.Join(dir, "lib", "libNianticLabsPlugin.so")); got != "plugin" {
		t.Errorf("plugin lib = %q", got)
	}
}

func TestInstallGameWithoutTheLibrary(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cos")
	bundle := zipFile(t, map[string]string{
		"base.apk": string(zipBytes(t, map[string]string{"classes.dex": "dex"})),
		"split_config.armeabi_v7a.apk": string(zipBytes(t, map[string]string{
			"lib/armeabi-v7a/libNianticLabsPlugin.so": "wrong abi",
		})),
	})
	err := InstallGame(bundle, dir, "arm64-v8a", "0.377.1")
	if err == nil || !strings.Contains(err.Error(), "arm64-v8a") {
		t.Fatalf("err = %v", err)
	}
	if got := GameVersion(dir); got != "" {
		t.Errorf("a failed install reports game version %q", got)
	}
}
