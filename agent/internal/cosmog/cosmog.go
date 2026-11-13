// Package cosmog installs the one MITM that is not an app.
//
// Aegis and GoCheats are APKs: `pm` installs them, `dumpsys` says which
// version is there, `am` stops and starts them. Cosmog 2 is none of that. It
// is a binary named after the game, run as root out of a directory of its own,
// beside the ART it was built against and the game's own native library:
//
//	/data/local/tmp/cos/
//	  com.nianticlabs.pokemongo      the binary
//	  config.toml                    written by the hub, never by this package
//	  cos.version                    what is installed, since nothing else says
//	  lib/libart.so                  shipped with the binary, version for version
//	  lib/libNianticLabsPlugin.so    out of the game's arm64 split
//	  files/base.apk                 the game, which Cosmog reads off disk
//	  files/split_config.arm64_v8a.apk
//	  pogo.version                   which game those three came from
//
// The layout is aconf's (github.com/TechG3n/aconf, scripts/cosmog.sh), which
// has been putting it on these boxes for years, so a box moved from one to the
// other is already where this expects it.
//
// Nothing here talks to Android. It is zip in, files out, which is what lets
// it be tested on a laptop and run unchanged on the fake fleet.
package cosmog

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"
)

const (
	// Package is what Cosmog is filed under on the hub. No such package is
	// ever installed; the name only keys a version, a rollout and a column.
	// `COSMOG_PACKAGE` in packages/apk is this same string.
	Package = "com.sy1vi3.cosmog"
	// GamePackage is the game, which on a Cosmog box is files and not an app.
	GamePackage = "com.nianticlabs.pokemongo"

	// Dir is where Cosmog lives. Not configurable, because the binary is not:
	// it finds its config, its lib and its files relative to here.
	Dir = "/data/local/tmp/cos"

	// Binary is the executable's name -- the game's package name, on purpose.
	Binary = "com.nianticlabs.pokemongo"

	libart     = "lib/libart.so"
	pluginLib  = "libNianticLabsPlugin.so"
	configFile = "config.toml"

	versionFile     = "cos.version"
	gameVersionFile = "pogo.version"

	defaultAbi = "arm64-v8a"
)

// Version is the Cosmog installed under dir, or "" when there is none.
//
// A version file with no binary beside it is not an install: the file outlives
// a half-finished cleanup, and reporting it would have a rollout skip the box
// as already done.
func Version(dir string) string {
	if _, err := os.Stat(filepath.Join(dir, Binary)); err != nil {
		return ""
	}
	return firstLine(filepath.Join(dir, versionFile))
}

// GameVersion is the game whose library Cosmog is loading, or "".
func GameVersion(dir string) string {
	if _, err := os.Stat(filepath.Join(dir, "lib", pluginLib)); err != nil {
		return ""
	}
	return firstLine(filepath.Join(dir, gameVersionFile))
}

func firstLine(p string) string {
	data, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	line, _, _ := strings.Cut(string(data), "\n")
	return strings.TrimSpace(line)
}

// InstallBundle unpacks a Cosmog bundle into dir and records its version.
//
// The bundle is the zip as it is published: the binary at the root and
// `lib/libart.so` beside it, optionally inside one wrapping directory. Both
// are required -- the binary does not start without the libart it was built
// against, and the pair changes together, which is why they travel as one
// artifact with one checksum rather than as two downloads that can disagree.
//
// Everything else in the zip comes along, so a release that adds a file does
// not need a new agent. One name is never taken from it: config.toml, which
// is this site's credentials and the hub's to write.
//
// Each file is written beside its destination and renamed over it. The binary
// may well be running -- a join install has no hook to stop it -- and a
// running executable cannot be opened for writing, but it can be replaced.
func InstallBundle(zipPath, dir, version string) ([]string, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, fmt.Errorf("open cosmog bundle: %w", err)
	}
	defer r.Close()

	prefix, ok := bundlePrefix(r.File)
	if !ok {
		return nil, fmt.Errorf(
			"not a cosmog bundle: it needs %s and %s, at its root or inside one directory",
			Binary, libart)
	}

	if err := makeDirs(dir, filepath.Join(dir, "lib")); err != nil {
		return nil, err
	}

	var written []string
	for _, f := range r.File {
		if f.FileInfo().IsDir() || !strings.HasPrefix(f.Name, prefix) {
			continue
		}
		rel, ok := safeRel(strings.TrimPrefix(f.Name, prefix))
		if !ok {
			return written, fmt.Errorf("cosmog bundle holds a path that leaves it: %s", f.Name)
		}
		if rel == configFile {
			continue
		}

		mode := os.FileMode(0o644)
		if rel == Binary || f.Mode()&0o111 != 0 {
			mode = 0o755
		}
		dest := filepath.Join(dir, filepath.FromSlash(rel))
		if err := makeDirs(filepath.Dir(dest)); err != nil {
			return written, err
		}
		if err := extract(f, dest, mode); err != nil {
			return written, err
		}
		written = append(written, rel)
	}

	if err := writeFile(filepath.Join(dir, versionFile), version+"\n"); err != nil {
		return written, err
	}
	return written, nil
}

// InstallGame gives Cosmog the game: its APKs under files/, and the native
// library out of its ABI split under lib/.
//
// The artifact is the game's ordinary bundle, the same .apkm every other group
// installs through `pm`. Cosmog wants three things out of it and none of them
// installed -- which is the half of aconf's setup that used to mean unzipping
// a split by hand and renaming a .so after its version.
func InstallGame(apkmPath, dir, abi, version string) error {
	if abi == "" {
		abi = defaultAbi
	}
	r, err := zip.OpenReader(apkmPath)
	if err != nil {
		return fmt.Errorf("open game bundle: %w", err)
	}
	defer r.Close()

	base, split := gameEntries(r.File, abi)
	if base == nil {
		return fmt.Errorf("no base.apk in the game bundle")
	}

	filesDir := filepath.Join(dir, "files")
	libDir := filepath.Join(dir, "lib")
	if err := makeDirs(dir, filesDir, libDir); err != nil {
		return err
	}

	basePath := filepath.Join(filesDir, "base.apk")
	if err := extract(base, basePath, 0o644); err != nil {
		return err
	}
	// The library lives in the ABI split of a real bundle, and in the one APK
	// of a build somebody uploaded as a single file.
	sources := []string{basePath}
	if split != nil {
		splitPath := filepath.Join(filesDir, path.Base(split.Name))
		if err := extract(split, splitPath, 0o644); err != nil {
			return err
		}
		sources = []string{splitPath, basePath}
	}

	libEntry := "lib/" + abi + "/" + pluginLib
	found := false
	for _, source := range sources {
		ok, err := extractFromApk(source, libEntry, filepath.Join(libDir, pluginLib))
		if err != nil {
			return err
		}
		if ok {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("no %s in the game bundle: is this build for %s?", libEntry, abi)
	}

	return writeFile(filepath.Join(dir, gameVersionFile), version+"\n")
}

// bundlePrefix finds the directory a bundle's files sit under: "" for a zip of
// the files themselves, "name/" for a zip of the folder holding them.
func bundlePrefix(files []*zip.File) (string, bool) {
	names := map[string]bool{}
	for _, f := range files {
		names[f.Name] = true
	}
	for name := range names {
		if name != Binary && !strings.HasSuffix(name, "/"+Binary) {
			continue
		}
		prefix := strings.TrimSuffix(name, Binary)
		if strings.Count(prefix, "/") > 1 {
			continue
		}
		if names[prefix+libart] {
			return prefix, true
		}
	}
	return "", false
}

// gameEntries picks the base APK and the split for this ABI, by base name:
// bundles disagree about whether their entries sit in a directory.
func gameEntries(files []*zip.File, abi string) (base, split *zip.File) {
	splitName := "split_config." + strings.ReplaceAll(abi, "-", "_") + ".apk"
	var apks []*zip.File
	for _, f := range files {
		name := strings.ToLower(path.Base(f.Name))
		if !strings.HasSuffix(name, ".apk") {
			continue
		}
		apks = append(apks, f)
		switch name {
		case "base.apk":
			base = f
		case splitName:
			split = f
		}
	}
	// One APK under some other name is a single-file build: it is the base.
	if base == nil && len(apks) == 1 {
		base = apks[0]
	}
	return base, split
}

// safeRel cleans a zip entry's name and refuses one that would land outside
// the directory it is being unpacked into.
func safeRel(name string) (string, bool) {
	if name == "" || strings.Contains(name, "\\") {
		return "", false
	}
	clean := path.Clean(name)
	if clean == "." || path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	return clean, true
}

// makeDirs creates directories other users can write into.
//
// 0777, and set explicitly because MkdirAll's mode goes through the umask.
// Cosmog drops root once it is up (`dont_drop_perms = false` is the default),
// and then has to write its log and its workers' files into a directory root
// created. aconf's `chmod -R 777` is this, without the files.
func makeDirs(dirs ...string) error {
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o777); err != nil {
			return err
		}
		if err := os.Chmod(dir, 0o777); err != nil {
			return err
		}
	}
	return nil
}

var tmpCounter atomic.Uint64

func tempFor(dest string) string {
	return fmt.Sprintf("%s.%d-%d.tmp", dest, os.Getpid(), tmpCounter.Add(1))
}

func extract(f *zip.File, dest string, mode os.FileMode) error {
	rc, err := f.Open()
	if err != nil {
		return fmt.Errorf("read %s: %w", f.Name, err)
	}
	defer rc.Close()
	return writeAtomic(dest, rc, mode)
}

func extractFromApk(apkPath, entry, dest string) (bool, error) {
	r, err := zip.OpenReader(apkPath)
	if err != nil {
		return false, fmt.Errorf("open %s: %w", filepath.Base(apkPath), err)
	}
	defer r.Close()
	for _, f := range r.File {
		if f.Name == entry {
			return true, extract(f, dest, 0o644)
		}
	}
	return false, nil
}

func writeFile(dest, content string) error {
	return writeAtomic(dest, strings.NewReader(content), 0o644)
}

func writeAtomic(dest string, src io.Reader, mode os.FileMode) error {
	tmp := tempFor(dest)
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, src)
	if err == nil {
		err = out.Sync()
	}
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	// The mode again: OpenFile's is masked, and a leftover tmp keeps its own.
	if err == nil {
		err = os.Chmod(tmp, mode)
	}
	if err == nil {
		err = os.Rename(tmp, dest)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("write %s: %w", filepath.Base(dest), err)
	}
	return nil
}
