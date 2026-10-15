// Command magnemite-agent runs on each rooted Android TV box. It holds a
// WebSocket open to the hub and installs the .apkm updates the hub sends it.
//
// On a real box it is started as root by the Magisk module's service.sh, and
// inside a Redroid container by an init service — either way it is already root
// and never shells out to su. With -fake-root it simulates a box, which is how
// the fleet is load-tested without hardware.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"magnemite/agent/internal/agent"
	"magnemite/agent/internal/certfix"
	"magnemite/agent/internal/config"
	hostpkg "magnemite/agent/internal/host"
	"magnemite/agent/internal/netfix"
	"magnemite/agent/internal/sys"
)

// Set at build time: -ldflags "-X main.version=1.2.3"
var version = "dev"

// Where a machine keeps its compose project, matching RedroidHost's defaults.
// Constants rather than flags: the hub owns these values, and a machine that
// disagreed with the hub about which project its containers are under would
// have `--remove-orphans` consider all of them strangers.
const (
	hostProject = "magnemite-redroid"
	hostDir     = "/etc/magnemite/redroid"
)

func main() {
	var (
		configPath  = flag.String("config", "", "path to config.json (default "+config.DefaultPath+")")
		server      = flag.String("server", "", "hub base URL, e.g. https://magnemite.example.com")
		enrollToken = flag.String("enroll-token", "", "enrollment token, used once on first run")
		name        = flag.String("name", "", "friendly name for this box")
		workDir     = flag.String("work-dir", "", "scratch directory (default "+config.DefaultWorkDir+")")
		serial      = flag.String("serial", "", "serial to report instead of ro.serialno")
		rebootCmd   = flag.String("reboot-command", "", "what a reboot from the hub runs (default \"reboot\")")
		hostMode    = flag.Bool("host", false, "run as the Linux machine that holds Redroid containers, not as a box")
		fakeDocker  = flag.Bool("fake-docker", false, "in -host mode, stub only the docker calls")
		fakeRoot    = flag.Bool("fake-root", false, "simulate an Android box instead of touching a real one")
		fakeSerial  = flag.String("fake-serial", "", "serial to report in -fake-root mode")
		showVersion = flag.Bool("version", false, "print the agent version and exit")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	log.SetFlags(log.LstdFlags | log.Lmsgprefix)

	path := *configPath
	if path == "" {
		if *fakeRoot {
			path = filepath.Join(".", "magnemite-fake.json")
		} else {
			path = config.DefaultPath
		}
	}

	cfg, err := config.Load(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Fatalf("config: %v", err)
		}
		cfg = &config.Config{WorkDir: config.DefaultWorkDir}
	}

	// Flags win over the file, so a box can be re-pointed without editing JSON.
	if *server != "" {
		cfg.ServerURL = *server
	}
	if *enrollToken != "" {
		cfg.EnrollmentToken = *enrollToken
	}
	if *name != "" {
		cfg.Name = *name
	}
	if *workDir != "" {
		cfg.WorkDir = *workDir
	}
	if *serial != "" {
		cfg.Serial = *serial
	}
	if *rebootCmd != "" {
		cfg.RebootCommand = *rebootCmd
	}
	if cfg.ServerURL == "" {
		log.Fatalf("no server URL: pass -server or put serverUrl in %s", path)
	}

	var system sys.System
	var reporter agent.HostReporter
	var converger agent.Converger
	var bootstrapper agent.Bootstrapper

	switch {
	case *hostMode:
		// A machine, not a box. It is the same binary and the same socket; what
		// changes is where the readings come from and that a host block rides
		// along. See agent/internal/sys/host.go for why that type embeds the
		// Android one rather than reimplementing /proc.
		if cfg.Serial == "" {
			log.Fatalf("-host needs a serial: the hub keys a machine on it, and one derived from the machine itself would be cloned by a VPS snapshot")
		}
		host := sys.NewHost(cfg.Serial)
		system = host
		if cfg.WorkDir == "" || cfg.WorkDir == config.DefaultWorkDir {
			cfg.WorkDir = filepath.Join(os.TempDir(), "magnemite-host")
		}
		if *fakeDocker {
			fake := hostpkg.NewFakeReporter(hostProject, hostpkg.FakeInstancesFromEnv(0))
			reporter, converger = fake, fake
			log.Printf("running in -fake-docker mode — only the docker calls are stubbed")
		} else {
			real := hostpkg.NewReporter(hostProject, hostDir, host.DiskPath())
			reporter, converger = real, real.Docker
		}
		// Real in both modes, including -fake-docker: the fake exists to stub
		// the two docker calls, and nothing here is one. A fake fleet on a
		// laptop that was asked to re-run its bootstrap should fail the way a
		// machine without the script would, not pretend.
		bootstrapper = &hostpkg.Bootstrapper{}
		log.SetPrefix("[" + cfg.Serial + "] ")
		log.Printf("running as a Redroid host, measuring disk on %s", host.DiskPath())

	case *fakeRoot:
		serial := *fakeSerial
		if serial == "" {
			serial = "fake-" + filepath.Base(path)
		}
		if cfg.WorkDir == "" || cfg.WorkDir == config.DefaultWorkDir {
			cfg.WorkDir = filepath.Join(os.TempDir(), "magnemite-"+serial)
		}
		system = sys.NewFake(serial, path+".state")
		log.SetPrefix("[" + serial + "] ")
		log.Printf("running in fake-root mode — no real device is touched")

	default:
		system = sys.NewAndroid(cfg.Serial)
		if servers := netfix.Install(); len(servers) > 0 {
			// Android has no /etc/resolv.conf; without this every lookup fails.
			log.Printf("using dns servers from system properties: %v", servers)
		}
		if n := certfix.Install(); n > 0 {
			// Android has no /etc/ssl/certs either; without this every TLS
			// handshake fails with "certificate signed by unknown authority".
			log.Printf("loaded %d ca certificates from the android trust store", n)
		}
		if cfg.WorkDir == "" {
			cfg.WorkDir = config.DefaultWorkDir
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if cfg.DeviceToken == "" {
		log.Printf("enrolling with %s", cfg.ServerURL)
		if err := agent.Enroll(ctx, cfg, system, version, path); err != nil {
			log.Fatalf("enrollment failed: %v", err)
		}
		log.Printf("enrolled as %q", cfg.Name)
	}

	// Ties this log file to one boot and one process. It is the first thing
	// you want when two stretches of agent.log look alike: a box that rebooted
	// and a box whose agent respawned leave the same gap, and the uptime here
	// is what tells them apart.
	log.Printf("agent %s starting: pid %d, uptime %ds", version, os.Getpid(), system.UptimeSeconds())

	a := agent.New(cfg, system, version, path)
	// Nil on a box, which is what keeps the host block absent from everything a
	// box sends rather than present and empty.
	a.Host = reporter
	a.Converger = converger
	a.Bootstrapper = bootstrapper
	if err := a.Run(ctx); err != nil && ctx.Err() == nil {
		log.Fatalf("agent stopped: %v", err)
	}
	log.Printf("shutting down")
}
