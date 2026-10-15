// Package agent owns the long-lived connection to the hub and runs one job
// at a time on the box.
package agent

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"magnemite/agent/internal/certfix"
	"magnemite/agent/internal/config"
	"magnemite/agent/internal/installer"
	"magnemite/agent/internal/monitor"
	"magnemite/agent/internal/proto"
	"magnemite/agent/internal/sys"
)

const (
	writeTimeout     = 15 * time.Second
	pongTimeout      = 90 * time.Second
	minBackoff       = 2 * time.Second
	maxBackoff       = 60 * time.Second
	defaultHeartbeat = 20 * time.Second
	// Bounds on what the hub may ask for. Anything outside is treated as a
	// mistake and ignored: the fleet keeps beating at whatever it was on,
	// which is always safe, rather than adopting a value that would either
	// flood the hub or look offline.
	minHeartbeat = 5 * time.Second
	maxHeartbeat = 10 * time.Minute
	// One full package inventory every 15 heartbeats — five minutes at the
	// default rate.
	inventoryEveryBeats = 15

	// A whole beat's budget for the host block, and no more. Long enough for a
	// `compose ps` plus an inspect per container on a loaded machine; short
	// enough that a wedged daemon cannot stop the beat itself.
	hostReportTimeout = 20 * time.Second

	// A session that held this long is proof the connection works, so the
	// backoff goes back to its floor. Three beats at the default rate: long
	// enough to have actually reported, rather than merely to have dialled.
	backoffResetAfter = 60 * time.Second

	// What the expensive half of a beat gets. Generous, because nothing waits
	// on it any more: a pass that overruns is simply skipped by the next one,
	// and the heartbeat has already gone out without it.
	slowBudget = 30 * time.Second
)

// HostReporter is the half of a report only a machine running containers has.
//
// An interface and not a concrete type so the fake can stand in: the whole
// point of -fake-docker is that everything except the two docker calls is
// real, and that only works if the docker calls are the seam.
// Converger brings a machine's containers in line with a rendered compose
// file. Separate from HostReporter because the fake implements one of them
// trivially and the other almost entirely for real.
type Converger interface {
	Converge(ctx context.Context, req proto.HostConverge) proto.HostConvergeResult
}

// Bootstrapper re-runs the provisioning script on a machine already up. Its
// own interface for the reason Converger is one: the fake stands in for it.
type Bootstrapper interface {
	Run(ctx context.Context, req proto.HostBootstrap) proto.HostBootstrapResult
}

type HostReporter interface {
	// Report is what this machine is and what containers it is holding. It is
	// allowed to be slow -- it shells out -- and it is called once per beat.
	Report(ctx context.Context) *proto.HostInfo
}

type Agent struct {
	Cfg     *config.Config
	Sys     sys.System
	Version string
	// Path the config was loaded from, so a rotated token can be written back.
	ConfigPath string
	// Brings the containers in line with what the hub asked for. Nil on a box,
	// and nil in host mode until docker is wired up.
	Converger Converger
	// Runs the bootstrap again on command. Nil on a box, which is what makes
	// a misdirected request a log line rather than a shell.
	Bootstrapper Bootstrapper
	// Set only in host mode, and nil on every box.
	//
	// This is the whole of what -host changes about the client: the loop below
	// reconnects, enrols, beats, takes a welcome, runs exec and updates itself
	// identically either way. A machine is a Device, so none of that needed a
	// second copy.
	Host HostReporter

	mu      sync.Mutex
	conn    *websocket.Conn
	tracked []string
	// What to watch on each beat. Nil until a welcome says otherwise, which is
	// also what a fleet with monitoring switched off leaves it as.
	monitor *proto.MonitorSpec
	// How often to beat. The hub sets it in every welcome, so it survives a
	// reconnect without the loop having to wait for one.
	heartbeat time.Duration
	// When this process started. Constant for its life, and the thing that
	// tells the hub "the agent restarted" from "the box rebooted" — the two
	// leave the same gap and had been indistinguishable.
	startedAt time.Time

	// Wakes the heartbeat loop when the hub changes the interval mid-session.
	// Buffered and written to without blocking: a change that arrives while no
	// loop is running is picked up when the next one starts and reads
	// a.heartbeat anyway.
	rebeat chan time.Duration

	jobMu   sync.Mutex
	jobID   string
	jobStop context.CancelFunc

	// One follow per source, however many dashboards are watching it: the hub
	// shares a stream between everyone on the same source, and asks for a
	// second one only when someone is watching something else. Keyed by the
	// hub's stream id, valued by the follow's cancel.
	logMu      sync.Mutex
	logStreams map[string]*logFollow

	// The last completed pass of the expensive half of a beat, waiting for a
	// heartbeat to carry it, and whether a pass is running right now. Its own
	// mutex rather than `mu`: a pass holds this for minutes on a wedged box,
	// and `mu` is what every send has to take.
	slowMu  sync.Mutex
	slow    *slowReading
	slowRun bool
}

// sess is one connection's own identity and tally.
//
// The id goes in every line about this connection, so a stretch of agent.log
// can be matched to one episode in the dashboard rather than to a time range
// to squint at. The tally is so the exit line can say how much work actually
// happened on the session rather than only how long it lasted — "ended after
// 4m with 0 beats" and "ended after 4m with 12" are different faults.
type sess struct {
	id    string
	began time.Time

	mu       sync.Mutex
	beats    int
	lastBeat time.Time
}

func newSess() *sess {
	return &sess{id: fmt.Sprintf("%08x", rand.Uint32()), began: time.Now()}
}

func (s *sess) beat() {
	s.mu.Lock()
	s.beats++
	s.lastBeat = time.Now()
	s.mu.Unlock()
}

// tally is the beat count and how long ago the last one went out. A zero
// duration means there was never one at all, which is the interesting case.
func (s *sess) tally() (beats int, sinceLast time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastBeat.IsZero() {
		return s.beats, 0
	}
	return s.beats, time.Since(s.lastBeat)
}

// slowReading is one pass of the half of a beat that shells out: the package
// versions and the monitor probes.
//
// Gathered off the heartbeat's path and handed over whole, then read exactly
// once. Reading it once is the point: the monitor half is "how is this box
// right now" and the hub acts on it — replaying a stale one would have the
// fleet rebooted over the past. A beat that finds no new pass simply says
// monitorRan false, which the hub already reads as "the agent did not look".
type slowReading struct {
	packages   []proto.PackageInfo
	complete   bool
	monitorRan bool
	foreground string
	anr        []string
	checks     []proto.CheckResult
	host       *proto.HostInfo
}

func (r *slowReading) foldInto(m *proto.DeviceMetrics) {
	m.Packages = r.packages
	m.PackagesComplete = r.complete
	m.MonitorRan = r.monitorRan
	m.ForegroundPackage = r.foreground
	m.ANRPackages = r.anr
	m.Checks = r.checks
}

// logFollow is one running follow. Held by pointer so the goroutine that ends
// can tell its own entry from a later one started under the same stream id —
// which is what a reconnect does, re-arming the streams that are still watched.
type logFollow struct {
	cancel context.CancelFunc
}

func New(cfg *config.Config, system sys.System, version, configPath string) *Agent {
	return &Agent{
		Cfg:        cfg,
		Sys:        system,
		Version:    version,
		ConfigPath: configPath,
		startedAt:  time.Now(),
		tracked:    []string{"com.nianticlabs.pokemongo"},
		heartbeat:  defaultHeartbeat,
		rebeat:     make(chan time.Duration, 1),
	}
}

// Run reconnects forever. The only way out is ctx being cancelled.
func (a *Agent) Run(ctx context.Context) error {
	backoff := minBackoff

	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}

		began := time.Now()
		err := a.session(ctx)
		lasted := time.Since(began)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			log.Printf("connection lost: %v", err)
		}

		// A session that held for a few beats is proof the backoff has already
		// done its job. Without this the growth is one-way — the counter lives
		// for the life of the process — so a box that flapped once at 3am is
		// still waiting the full minute at noon, which turns a two-minute
		// fault into an all-day one.
		if lasted >= backoffResetAfter {
			backoff = minBackoff
		}

		// Jitter matters at fleet scale: a whole fleet reconnecting in lockstep
		// after the VPS restarts is a self-inflicted denial of service.
		jitter := time.Duration(rand.Int63n(int64(backoff / 4)))
		wait := backoff - backoff/8 + jitter
		log.Printf("reconnecting in %s (backoff %s)", wait.Round(time.Second), backoff)

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}

		backoff = time.Duration(float64(backoff) * 1.7)
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

func (a *Agent) session(ctx context.Context) error {
	wsURL, err := a.wsURL()
	if err != nil {
		return err
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 20 * time.Second,
		Proxy:            http.ProxyFromEnvironment,
		// The dialer builds its own TLS config, so it misses the roots
		// certfix put on http.DefaultTransport. A nil pool means "platform
		// roots", which is what we want everywhere but Android.
		TLSClientConfig: &tls.Config{RootCAs: certfix.Pool()},
	}
	headers := http.Header{}
	headers.Set("Authorization", "Bearer "+a.Cfg.DeviceToken)
	headers.Set("User-Agent", "magnemite-agent/"+a.Version)

	conn, resp, err := dialer.DialContext(ctx, wsURL, headers)
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return fmt.Errorf("device token rejected — re-enroll this box")
		}
		return fmt.Errorf("dial %s: %w", wsURL, err)
	}
	ss := newSess()
	log.Printf("session %s: connected to %s", ss.id, wsURL)

	a.mu.Lock()
	a.conn = conn
	a.mu.Unlock()

	defer func() {
		beats, sinceLast := ss.tally()
		log.Printf("session %s: ended after %s (%d beats, last %s ago)",
			ss.id, time.Since(ss.began).Round(time.Second), beats, sinceLast.Round(time.Second))
		a.mu.Lock()
		if a.conn == conn {
			a.conn = nil
		}
		a.mu.Unlock()
		// Nobody is reading the lines any more, so stop paying for them.
		a.stopLogStream("")
		conn.Close()
	}()

	conn.SetReadDeadline(time.Now().Add(pongTimeout))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongTimeout))
	})
	// Gorilla's default answers the hub's keepalive on a one-second write
	// deadline and swallows the timeout as "temporary", so a pong stuck behind
	// a slow frame is invisible at both ends — and two of them have the hub
	// hang up on a box that was working. Ours gets the same deadline as any
	// other write, and says so when it still cannot get out.
	conn.SetPingHandler(func(data string) error {
		err := conn.WriteControl(websocket.PongMessage, []byte(data), time.Now().Add(writeTimeout))
		if err != nil && !errors.Is(err, websocket.ErrCloseSent) {
			log.Printf("session %s: could not answer the hub's keepalive: %v", ss.id, err)
		}
		// nil on purpose: a missed keepalive is worth seeing, not worth
		// dropping a connection that is otherwise carrying frames.
		return nil
	})

	sessionCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	if err := a.sendHello(ss.id); err != nil {
		return err
	}
	go a.heartbeatLoop(sessionCtx, ss)

	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if errors.Is(err, os.ErrDeadlineExceeded) {
				// Worth its own wording: nothing arrived at all, not even a
				// keepalive, so the link died rather than the hub closing it.
				return fmt.Errorf("nothing from the hub in %s", pongTimeout)
			}
			return err
		}
		conn.SetReadDeadline(time.Now().Add(pongTimeout))
		a.handle(ctx, data)
	}
}

// endSession drops the connection out from under the read loop.
//
// Closing the conn is what makes ReadMessage return, which unwinds session()
// through its own defer and lets Run reconnect. Cancelling the session context
// would not do it: nothing inside ReadMessage is selecting on it.
func (a *Agent) endSession() {
	a.mu.Lock()
	conn := a.conn
	a.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

func (a *Agent) wsURL() (string, error) {
	base := strings.TrimSuffix(a.Cfg.ServerURL, "/")
	switch {
	case strings.HasPrefix(base, "https://"):
		return "wss://" + strings.TrimPrefix(base, "https://") + "/ws/device", nil
	case strings.HasPrefix(base, "http://"):
		return "ws://" + strings.TrimPrefix(base, "http://") + "/ws/device", nil
	case strings.HasPrefix(base, "ws://"), strings.HasPrefix(base, "wss://"):
		return base + "/ws/device", nil
	}
	return "", fmt.Errorf("serverUrl %q must start with http:// or https://", a.Cfg.ServerURL)
}

func (a *Agent) send(v any) error {
	a.mu.Lock()
	conn := a.conn
	a.mu.Unlock()
	if conn == nil {
		return fmt.Errorf("not connected")
	}

	data, err := json.Marshal(v)
	if err != nil {
		return err
	}

	// gorilla/websocket allows exactly one concurrent writer, and the
	// heartbeat loop races the job reporter.
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.conn != conn {
		return fmt.Errorf("connection replaced")
	}
	conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return conn.WriteMessage(websocket.TextMessage, data)
}

func (a *Agent) sendHello(sessionID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// A reconnect is the cheapest moment to take a full inventory: the hub has
	// just lost sight of this box and one `pm list` is nothing next to the
	// reconnect itself.
	metrics := sys.Metrics(ctx, a.Sys, a.trackedPackages(), true)
	a.applyMonitor(ctx, &metrics)

	info := a.Sys.DeviceInfo(ctx)
	// Filled here rather than inside DeviceInfo because only the agent knows
	// two of the three, and because the boot instant wants taking at the same
	// moment as the uptime it is derived from.
	info.BootedAt = time.Now().Unix() - a.Sys.UptimeSeconds()
	info.AgentStartedAt = a.startedAt.Unix()
	info.SessionID = sessionID

	return a.send(proto.Hello{
		Type:            "hello",
		ProtocolVersion: proto.Version,
		AgentVersion:    a.Version,
		Device:          info,
		Metrics:         metrics,
		CurrentJobID:    a.currentJob(),
		Capabilities:    proto.AgentCapabilities(),
		Host:            a.hostReport(ctx),
	})
}

// hostReport is nil on a box, which is what keeps the field absent from every
// message a box sends rather than present and empty.
//
// Given its own timeout rather than the caller's: it shells out to docker, and
// a daemon that has wedged must cost this beat its host block and nothing else.
// A machine whose docker is gone still has to heartbeat -- that is the fault
// the hub needs to see, and a beat that never arrives looks like a different
// one.
func (a *Agent) hostReport(ctx context.Context) *proto.HostInfo {
	if a.Host == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, hostReportTimeout)
	defer cancel()
	return a.Host.Report(ctx)
}

// monitorSpec is what to watch this beat, or nil when there is nothing to
// watch — or when a job is running. An install force-stops the scanner on
// purpose, so every probe would faithfully report the damage the hub itself
// asked for, and the hub would act on it.
func (a *Agent) monitorSpec() *proto.MonitorSpec {
	if a.currentJob() != "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.monitor
}

// applyMonitor folds this beat's answers into the metrics about to go out.
//
// Budgeted at half the interval: probes are worth having only for as long as
// they leave room for the heartbeat itself, and one slow dumpsys must not be
// what stops a box reporting at all.
func (a *Agent) applyMonitor(ctx context.Context, metrics *proto.DeviceMetrics) {
	spec := a.monitorSpec()
	if spec == nil {
		return
	}

	a.mu.Lock()
	interval := a.heartbeat
	a.mu.Unlock()
	if interval <= 0 {
		interval = defaultHeartbeat
	}

	result := monitor.Collect(ctx, a.Sys, spec, interval/2)
	metrics.MonitorRan = true
	metrics.ForegroundPackage = result.Foreground
	metrics.ANRPackages = result.ANR
	metrics.Checks = result.Checks
}

// setHeartbeat adopts an interval the hub asked for in its welcome.
//
// Out of range is ignored rather than clamped: a nonsense interval is far more
// likely a bug at the other end than an intention, and carrying on at the
// current rate is always the safe reading of it.
func (a *Agent) setHeartbeat(seconds int) {
	d := time.Duration(seconds) * time.Second
	if d < minHeartbeat || d > maxHeartbeat {
		if seconds != 0 {
			log.Printf("ignoring heartbeat interval of %ds from the hub", seconds)
		}
		return
	}

	a.mu.Lock()
	changed := a.heartbeat != d
	a.heartbeat = d
	a.mu.Unlock()
	if !changed {
		return
	}

	log.Printf("heartbeat interval is now %s", d)
	select {
	case a.rebeat <- d:
	default:
	}
}

// heartbeatLoop sends the beat the hub measures liveness by.
//
// The beat carries only readings that cannot block — a statfs and a handful of
// /proc reads — plus whatever the last expensive pass left behind. Everything
// that shells out happens in collectSlow, off this path.
//
// That split is the whole point. The gathering used to run inline: a 30s
// metrics budget, half an interval of monitor probes and a 15s write, on top
// of the interval itself. One beat that saturated them put 75 seconds between
// two reports, against a hub that gives up at 70 — so a box that was sitting
// there perfectly healthy, socket and all, was announced as unreachable.
func (a *Agent) heartbeatLoop(ctx context.Context, ss *sess) {
	a.mu.Lock()
	interval := a.heartbeat
	a.mu.Unlock()
	if interval <= 0 {
		interval = defaultHeartbeat
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	beats := 0

	for {
		select {
		case <-ctx.Done():
			return
		case d := <-a.rebeat:
			// Reset rather than a fresh ticker, so the beat count — and with
			// it the inventory cadence — carries across the change.
			ticker.Reset(d)
			interval = d
		case <-ticker.C:
			beats++
			began := time.Now()

			metrics := sys.BaseMetrics(a.Sys, a.trackedPackages())
			var host *proto.HostInfo
			if slow := a.takeSlow(); slow != nil {
				slow.foldInto(&metrics)
				host = slow.host
			}

			if err := a.send(proto.Heartbeat{
				Type:         "heartbeat",
				Metrics:      metrics,
				CurrentJobID: a.currentJob(),
				Host:         host,
			}); err != nil {
				// This was a bare return: nothing logged, the socket left
				// open, and not one more beat on this session ever. The hub
				// went on holding a live socket for a box it would then mark
				// offline by sweep, and only its own read deadline eventually
				// broke the deadlock. A box that cannot send its beat does not
				// have a working connection, whatever the socket believes.
				log.Printf("session %s: heartbeat send failed after %s: %v — ending the session",
					ss.id, time.Since(began).Round(time.Millisecond), err)
				a.endSession()
				return
			}
			ss.beat()

			a.mu.Lock()
			conn := a.conn
			if conn != nil {
				conn.SetWriteDeadline(time.Now().Add(writeTimeout))
				_ = conn.WriteMessage(websocket.PingMessage, nil)
			}
			a.mu.Unlock()

			// Silent on a healthy box, which is what makes it worth reading:
			// after the split above a beat is microseconds, so a line here at
			// all means the cheap half is no longer cheap.
			if cost := time.Since(began); cost > interval {
				log.Printf("session %s: slow beat — %s to gather and send, on an interval of %s",
					ss.id, cost.Round(time.Millisecond), interval)
			}

			// Apps are installed and removed by hand on these boxes, so the
			// inventory does go stale — but not by the second. Every
			// inventoryEveryBeats heartbeats keeps it current at a cost of one
			// `pm list packages` every few minutes.
			go a.collectSlow(ctx, ss, beats%inventoryEveryBeats == 0)
		}
	}
}

// takeSlow hands over the last completed pass and clears the slot, so no
// reading is ever sent twice. See slowReading for why that matters.
func (a *Agent) takeSlow() *slowReading {
	a.slowMu.Lock()
	defer a.slowMu.Unlock()
	r := a.slow
	a.slow = nil
	return r
}

// collectSlow gathers the half of a beat that shells out, for the next beat to
// carry.
//
// Skipped outright while a pass is still running, which is the point: on a box
// whose framework is restarting every `dumpsys` blocks until its deadline, and
// the right answer is to let the inventory go stale rather than to queue up
// passes behind a wedge. The heartbeat has already gone out without it.
func (a *Agent) collectSlow(ctx context.Context, ss *sess, withInventory bool) {
	a.slowMu.Lock()
	if a.slowRun {
		a.slowMu.Unlock()
		return
	}
	a.slowRun = true
	a.slowMu.Unlock()

	defer func() {
		a.slowMu.Lock()
		a.slowRun = false
		a.slowMu.Unlock()
	}()

	began := time.Now()
	ctx, cancel := context.WithTimeout(ctx, slowBudget)
	defer cancel()

	tracked := a.trackedPackages()
	r := &slowReading{host: a.hostReport(ctx)}
	r.packages, r.complete = sys.PackageVersions(ctx, a.Sys, tracked, withInventory)

	// The signature of a framework restart — a Redroid `stop && start`, or a
	// system_server that died — as against a box that is simply busy. Every
	// one of these goes through system_server, so all of them failing at once
	// says what failed.
	if len(tracked) > 0 && len(r.packages) == 0 {
		log.Printf("session %s: dumpsys answered for 0 of %d packages in %s — the framework may be restarting",
			ss.id, len(tracked), time.Since(began).Round(time.Millisecond))
	}

	// Through applyMonitor rather than monitor.Collect directly, so the probe
	// budget stays defined in exactly one place.
	var probe proto.DeviceMetrics
	a.applyMonitor(ctx, &probe)
	r.monitorRan = probe.MonitorRan
	r.foreground = probe.ForegroundPackage
	r.anr = probe.ANRPackages
	r.checks = probe.Checks

	a.slowMu.Lock()
	a.slow = r
	a.slowMu.Unlock()
}

func (a *Agent) handle(ctx context.Context, data []byte) {
	var env proto.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		log.Printf("dropped malformed frame: %v", err)
		return
	}

	switch env.Type {
	case "welcome":
		var msg proto.Welcome
		if json.Unmarshal(data, &msg) != nil {
			return
		}
		if len(msg.TrackedPackages) > 0 {
			a.mu.Lock()
			a.tracked = msg.TrackedPackages
			a.mu.Unlock()
		}
		// Replaced outright, including with nil: a rule being switched off in
		// the dashboard has to stop the probe running, and "no spec" is a
		// state the hub is allowed to put this box into.
		a.mu.Lock()
		a.monitor = msg.Monitor
		a.mu.Unlock()
		if a.Cfg.DeviceID != msg.DeviceID {
			a.Cfg.DeviceID = msg.DeviceID
			_ = a.Cfg.Save(a.ConfigPath)
		}
		a.setHeartbeat(msg.HeartbeatSeconds)
		log.Printf("registered as %q (approved=%v)", msg.Name, msg.Approved)
		if !msg.Approved {
			log.Printf("waiting for an operator to approve this device in the dashboard")
		}

	case "host_bootstrap":
		// Only a machine has a bootstrap to re-run. A box ignoring this is the
		// protocol's rule working; saying so is what stops a misdirected one
		// being silent.
		if a.Bootstrapper == nil {
			log.Printf("ignoring host_bootstrap: this agent is not running in -host mode")
			return
		}
		var req proto.HostBootstrap
		if json.Unmarshal(data, &req) != nil {
			return
		}
		// Its own goroutine, like the converge: this is apt, a kernel module
		// and possibly an image build, and the read loop has to keep taking
		// frames -- including the pings that stop the hub deciding the machine
		// has gone while it is working.
		go func() {
			log.Printf("re-running the bootstrap (%d files, image %s)", len(req.Files), req.Image)
			result := a.Bootstrapper.Run(ctx, req)
			if result.Ok {
				log.Printf("bootstrap %s done: %d steps", req.RequestID, len(result.Steps))
			} else {
				log.Printf("bootstrap %s failed: %s", req.RequestID, result.Error)
			}
			if err := a.send(result); err != nil {
				log.Printf("could not report the bootstrap: %v", err)
			}
		}()

	case "host_converge":
		// Only a machine has containers to converge. A box ignoring this is the
		// protocol's own rule working: the type switch has no default branch,
		// so an unknown message falls straight through -- but being explicit
		// here means a misdirected converge is logged rather than silent.
		if a.Converger == nil {
			log.Printf("ignoring host_converge: this agent is not running in -host mode")
			return
		}
		var req proto.HostConverge
		if json.Unmarshal(data, &req) != nil {
			return
		}
		// Its own goroutine: a converge is minutes of image pulls and Android
		// boots, and the read loop has to keep taking frames -- including the
		// pings that stop the hub deciding this machine has gone.
		go func() {
			log.Printf("converging %d bytes of compose (batch %d, orphans %v)",
				len(req.Compose), req.BatchSize, req.RemoveOrphans)
			result := a.Converger.Converge(ctx, req)
			if result.Ok {
				log.Printf("converge %s done", req.RequestID)
			} else {
				log.Printf("converge %s failed: %s", req.RequestID, result.Error)
			}
			if err := a.send(result); err != nil {
				log.Printf("could not report the converge: %v", err)
			}
		}()

	case "install_job":
		var job proto.InstallJob
		if json.Unmarshal(data, &job) != nil {
			return
		}
		a.startJob(ctx, job)

	case "cancel_job":
		var msg proto.CancelJob
		if json.Unmarshal(data, &msg) != nil {
			return
		}
		a.cancelJob(msg.JobID)

	case "reboot":
		// A box with its own kernel reboots. A container has none to restart —
		// it shares the host's, and the kernel refuses reboot(2) without
		// CAP_SYS_BOOT — so it points this at a framework restart instead. Same
		// intent either way: everything the box was running comes back up.
		cmd := a.Cfg.RebootCommand
		if cmd == "" {
			cmd = "reboot"
		}
		log.Printf("reboot requested by hub: %s", cmd)
		go func() {
			rctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			// Give the frame a moment to reach the hub before the box drops.
			time.Sleep(2 * time.Second)
			_, _ = a.Sys.Shell(rctx, cmd)
		}()

	case "agent_update":
		var msg proto.AgentUpdate
		if json.Unmarshal(data, &msg) != nil {
			return
		}
		go a.selfUpdate(msg)

	case "collect_logs":
		var msg proto.CollectLogs
		if json.Unmarshal(data, &msg) != nil {
			return
		}
		go a.collectLogs(msg)

	case "collect_screenshot":
		var msg proto.CollectScreenshot
		if json.Unmarshal(data, &msg) != nil {
			return
		}
		// Its own goroutine, like the bundle above: the read loop has to keep
		// taking frames while a megabyte goes up whatever uplink this box has.
		go a.collectScreenshot(msg)

	case "log_stream_start":
		var msg proto.LogStreamStart
		if json.Unmarshal(data, &msg) != nil {
			return
		}
		a.startLogStream(msg)

	case "log_stream_stop":
		var msg proto.LogStreamStop
		if json.Unmarshal(data, &msg) != nil {
			return
		}
		a.stopLogStream(msg.StreamID)

	case "exec_command":
		var msg proto.ExecCommand
		if json.Unmarshal(data, &msg) != nil {
			return
		}
		go a.execCommand(msg)

	case "ping":
		// The frame-level pong is enough; nothing to do.
	}
}

// --- jobs ------------------------------------------------------------------

func (a *Agent) currentJob() string {
	a.jobMu.Lock()
	defer a.jobMu.Unlock()
	return a.jobID
}

func (a *Agent) startJob(ctx context.Context, job proto.InstallJob) {
	a.jobMu.Lock()
	if a.jobID != "" {
		running := a.jobID
		a.jobMu.Unlock()
		// One install at a time. The hub re-queues anything it does not get a
		// result for, so refusing here is safe.
		log.Printf("ignoring job %s: %s is still running", job.JobID, running)
		_ = a.send(proto.JobResult{
			Type:  "job_result",
			JobID: job.JobID,
			OK:    false,
			Error: "agent is already running job " + running,
		})
		return
	}

	timeout := time.Duration(job.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = time.Hour
	}
	jobCtx, cancel := context.WithTimeout(ctx, timeout)
	a.jobID = job.JobID
	a.jobStop = cancel
	a.jobMu.Unlock()

	// Let the fake box know what version a commit should report.
	if fake, ok := a.Sys.(*sys.Fake); ok {
		fake.SetPendingVersion(job.Version)
	}

	go func() {
		defer func() {
			cancel()
			a.jobMu.Lock()
			a.jobID = ""
			a.jobStop = nil
			a.jobMu.Unlock()
		}()

		log.Printf("job %s: installing %s %s", job.JobID, job.PackageName, job.Version)
		rep := &reporter{agent: a, jobID: job.JobID}

		inst := &installer.Installer{
			Sys:     a.Sys,
			WorkDir: a.Cfg.WorkDir,
			Token:   a.Cfg.DeviceToken,
			Client:  &http.Client{Timeout: 0},
			// So a job carrying a config cannot be pointed at the file holding
			// this box's own device token.
			AgentConfigPath: a.ConfigPath,
		}
		res := inst.Run(jobCtx, job, rep)

		result := proto.JobResult{
			Type:                 "job_result",
			JobID:                job.JobID,
			OK:                   res.OK,
			InstallMode:          res.InstallMode,
			DataWiped:            res.DataWiped,
			InstalledVersion:     res.InstalledVersion,
			InstalledVersionCode: res.InstalledVersionCode,
		}
		if res.Err != nil {
			result.Error = res.Err.Error()
			log.Printf("job %s failed: %v", job.JobID, res.Err)
		} else {
			log.Printf("job %s succeeded: %s", job.JobID, res.InstalledVersion)
		}

		// If the socket is down the hub will time the job out and re-queue it;
		// the download is already on disk, so the retry is cheap.
		if err := a.send(result); err != nil {
			log.Printf("could not report result for %s: %v", job.JobID, err)
		}
	}()
}

func (a *Agent) cancelJob(jobID string) {
	a.jobMu.Lock()
	defer a.jobMu.Unlock()
	if a.jobID == jobID && a.jobStop != nil {
		log.Printf("cancelling job %s", jobID)
		a.jobStop()
	}
}

func (a *Agent) trackedPackages() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]string, len(a.tracked))
	copy(out, a.tracked)
	return out
}

// reporter forwards installer progress to the hub.
type reporter struct {
	agent *Agent
	jobID string
}

func (r *reporter) Progress(state string, percent int, message string) {
	_ = r.agent.send(proto.JobProgress{
		Type:     "job_progress",
		JobID:    r.jobID,
		State:    state,
		Progress: percent,
		Message:  message,
	})
}

func (r *reporter) Log(level, message string) {
	log.Printf("job %s: %s", r.jobID, message)
	_ = r.agent.send(proto.LogMessage{
		Type:    "log",
		JobID:   r.jobID,
		Level:   level,
		Message: message,
	})
}
