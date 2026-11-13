package installer

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"magnemite/agent/internal/cosmog"
	"magnemite/agent/internal/proto"
	"magnemite/agent/internal/sys"
)

type quietReporter struct{ lines []string }

func (q *quietReporter) Progress(string, int, string) {}
func (q *quietReporter) Log(_, message string)        { q.lines = append(q.lines, message) }

func zipOf(t *testing.T, files map[string]string) []byte {
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

// serve hands one artifact out the way the hub's /files does, and fills in the
// parts of a job that describe it.
func serve(t *testing.T, artifact []byte, job proto.InstallJob) proto.InstallJob {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(artifact)
	}))
	t.Cleanup(srv.Close)

	sum := sha256.Sum256(artifact)
	job.Type = "install_job"
	job.URL = srv.URL + "/files/artifact"
	job.SHA256 = hex.EncodeToString(sum[:])
	job.SizeBytes = int64(len(artifact))
	job.TimeoutSeconds = 60
	return job
}

func fakeBox(t *testing.T) (*sys.Fake, *Installer) {
	t.Helper()
	root := t.TempDir()
	fake := sys.NewFake("fake-001", filepath.Join(root, "fake-001.json.state"))
	return fake, &Installer{Sys: fake, WorkDir: filepath.Join(root, "work"), Token: "t"}
}

// The whole point: a Cosmog box built from nothing by two jobs, the order a
// join install sends them in -- the game first, the MITM and its config last.
func TestCosmogBoxFromNothing(t *testing.T) {
	fake, inst := fakeBox(t)
	ctx := context.Background()
	dir := fake.LocalPath(cosmog.Dir)

	game := zipOf(t, map[string]string{
		"base.apk": string(zipOf(t, map[string]string{"classes.dex": "dex"})),
		"split_config.arm64_v8a.apk": string(zipOf(t, map[string]string{
			"lib/arm64-v8a/libNianticLabsPlugin.so": "plugin",
		})),
	})
	res := inst.Run(ctx, serve(t, game, proto.InstallJob{
		JobID: "j1", PackageName: cosmog.GamePackage, Version: "0.377.1",
		Kind: proto.InstallKindCosmogGame,
	}), &quietReporter{})
	if !res.OK {
		t.Fatalf("game job: %v", res.Err)
	}
	if res.InstalledVersion != "0.377.1" {
		t.Errorf("game job reported %q", res.InstalledVersion)
	}

	// Nothing went through pm: the game is files, not an app.
	if third, _ := fake.ThirdPartyPackages(ctx); containsPackage(third, cosmog.GamePackage) {
		t.Error("the game was installed as an app on a Cosmog box")
	}
	// But the box says which game Cosmog is loading, so a rollout can skip it.
	if info, _ := fake.PackageInfo(ctx, cosmog.GamePackage); !info.Installed || info.VersionName != "0.377.1" {
		t.Errorf("game reported as %+v", info)
	}
	if info, _ := fake.PackageInfo(ctx, cosmog.Package); info.Installed {
		t.Errorf("cosmog reported installed by a game job: %+v", info)
	}

	bundle := zipOf(t, map[string]string{cosmog.Binary: "ELF", "lib/libart.so": "art"})
	configPath := cosmog.Dir + "/config.toml"
	rep := &quietReporter{}
	res = inst.Run(ctx, serve(t, bundle, proto.InstallJob{
		JobID: "j2", PackageName: cosmog.Package, Version: "2.1.3",
		Kind:   proto.InstallKindCosmog,
		Config: &proto.ConfigFile{Path: configPath, Content: "[general]\nworkers = 50\n", Mode: "0644"},
	}), rep)
	if !res.OK {
		t.Fatalf("cosmog job: %v", res.Err)
	}
	if res.InstalledVersion != "2.1.3" {
		t.Errorf("cosmog job reported %q", res.InstalledVersion)
	}

	for rel, want := range map[string]string{
		cosmog.Binary:                 "ELF",
		"lib/libart.so":               "art",
		"lib/libNianticLabsPlugin.so": "plugin",
		"cos.version":                 "2.1.3\n",
		"pogo.version":                "0.377.1\n",
	} {
		got, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil || string(got) != want {
			t.Errorf("%s = %q, %v; want %q", rel, got, err, want)
		}
	}
	if got, err := os.ReadFile(fake.LocalPath(configPath)); err != nil || !strings.Contains(string(got), "workers = 50") {
		t.Errorf("config = %q, %v", got, err)
	}
	if info, _ := fake.PackageInfo(ctx, cosmog.Package); !info.Installed || info.VersionName != "2.1.3" {
		t.Errorf("cosmog reported as %+v", info)
	}
	// The artifact has done its job.
	if left, _ := filepath.Glob(filepath.Join(inst.WorkDir, "*.apkm")); len(left) != 0 {
		t.Errorf("left %v behind", left)
	}
}

func TestCosmogJobWithAnApkInIt(t *testing.T) {
	fake, inst := fakeBox(t)
	ctx := context.Background()
	apk := zipOf(t, map[string]string{"base.apk": "x"})

	res := inst.Run(ctx, serve(t, apk, proto.InstallJob{
		JobID: "j1", PackageName: cosmog.Package, Version: "2.1.3", Kind: proto.InstallKindCosmog,
	}), &quietReporter{})
	if res.OK || res.Err == nil || !strings.Contains(res.Err.Error(), "not a cosmog bundle") {
		t.Fatalf("res = %+v", res)
	}
	if info, _ := fake.PackageInfo(ctx, cosmog.Package); info.Installed {
		t.Errorf("reported installed: %+v", info)
	}
}

// A kind from a newer hub must never fall through to a pm install.
func TestUnknownKindIsNotAnApk(t *testing.T) {
	fake, inst := fakeBox(t)
	ctx := context.Background()
	apk := zipOf(t, map[string]string{"base.apk": "x"})

	res := inst.Run(ctx, serve(t, apk, proto.InstallJob{
		JobID: "j1", PackageName: "com.example.app", Version: "1", Kind: "something_new",
	}), &quietReporter{})
	if res.OK || res.Err == nil || !strings.Contains(res.Err.Error(), "something_new") {
		t.Fatalf("res = %+v", res)
	}
	if third, _ := fake.ThirdPartyPackages(ctx); containsPackage(third, "com.example.app") {
		t.Error("installed it through pm anyway")
	}
}

func containsPackage(list []proto.PackageInfo, pkg string) bool {
	for _, info := range list {
		if info.PackageName == pkg {
			return true
		}
	}
	return false
}
