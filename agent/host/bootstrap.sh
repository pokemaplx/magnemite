#!/bin/sh
# Gets a fresh Linux machine ready to run Redroid containers, then starts the
# agent on it.
#
# Pushed and run by the hub over one outbound SSH connection, which is the only
# moment anything connects *towards* a machine. Afterwards the agent dials out
# like any box and this script is never needed again -- except to re-run, which
# is the whole point of it being idempotent. See "the kernel trap" below.
#
# Also runnable by hand, for a fleet that would rather the hub never hold SSH
# access: copy this and the agent binary across and run it with the same
# environment.
#
#   MAGNEMITE_SERVER=https://magnemite.example.com \
#   MAGNEMITE_TOKEN=<host enrollment token> \
#   MAGNEMITE_NAME=hel-01 \
#   MAGNEMITE_SERIAL=<minted by the hub> \
#   sh bootstrap.sh
#
# Every stage prints `::step <name> <ok|fail> [detail]` on stdout. That is not
# decoration: the hub parses those lines into per-step progress, because a
# bootstrap that fails on the fourth stage has to say which one and why rather
# than just failing. Keep the format if you add a stage.
#
# POSIX sh, not bash: a minimal cloud image is not guaranteed to have bash, and
# this is the one script that has to run before anything has been installed.

set -eu

AGENT_BIN=${AGENT_BIN:-./magnemite-agent}
CONF_DIR=/etc/magnemite
CONF=$CONF_DIR/host.json
INSTALL_BIN=/usr/local/bin/magnemite-agent
LIB_DIR=/usr/local/lib/magnemite
UNIT=/etc/systemd/system/magnemite-host.service

# A fresh cloud image is usually running unattended-upgrades on first boot, and
# apt waits on dpkg's lock *forever* by default -- so a provisioning started a
# minute after the machine was created hangs with no output and no timeout,
# which from the outside is indistinguishable from a dead connection. Five
# minutes is longer than that first run takes and shorter than anyone's
# patience.
#
# Defined here rather than inside the first step that needs it, so no later
# step depends on an earlier one having run -- `set -u` would otherwise turn a
# skipped block into "APT: unbound variable" three stages later.
APT="apt-get -o DPkg::Lock::Timeout=300"

step() { printf '::step %s %s %s\n' "$1" "$2" "${3:-}"; }

# A stage that fails says so in the machine-readable line *and* on stderr, then
# stops. `set -e` alone would exit silently, and the hub would be left with a
# connection that closed and no reason.
die() {
	step "$1" fail "$2"
	echo "bootstrap failed at $1: $2" >&2
	exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

# --- 1. arm64, or stop ------------------------------------------------------
#
# A hard requirement rather than a preference, and the failure most likely to
# happen on a machine somebody just bought. The fleet's .apkm bundles carry an
# arm64-v8a split and the agent picks a split by exact ABI match, so an x86_64
# host would need ARM translation and a different split policy. Better to
# refuse here than to have containers that boot and install nothing.
ARCH=$(uname -m)
case "$ARCH" in
aarch64 | arm64) step arch ok "$ARCH" ;;
*) die arch "$ARCH is not arm64 — Redroid boxes need an arm64 host" ;;
esac

if [ "$(id -u)" -ne 0 ]; then
	die root "must run as root (or under sudo)"
fi

# --- 2. the binder kernel module --------------------------------------------
#
# The step everyone misses: on Ubuntu, binder_linux lives in
# linux-modules-extra-$(uname -r), and cloud images frequently do not install
# it. Without it a container boots and Android never comes up, which looks like
# anything except a missing kernel module.
#
# ashmem_linux is deliberately *not* installed: the compose file sets
# androidboot.use_memfd=true, which is what replaced it.
KERNEL=$(uname -r)
if have apt-get; then
	export DEBIAN_FRONTEND=noninteractive
	# A fresh cloud image is usually running unattended-upgrades on first boot,
	# and apt waits on dpkg's lock *forever* by default -- so a provisioning
	# started a minute after the machine was created hangs with no output and
	# no timeout, which is indistinguishable from a dead connection. Five
	# minutes is longer than that first run takes and shorter than anyone's
	# patience.
	$APT update -qq >/dev/null 2>&1 || true
	# Not fatal on its own: a kernel with CONFIG_ANDROID_BINDERFS built in
	# needs no module at all, and the check below is what actually decides.
	$APT install -y -qq "linux-modules-extra-$KERNEL" >/dev/null 2>&1 ||
		step modules warn "no linux-modules-extra-$KERNEL (may be built in)"
fi

modprobe binder_linux devices="binder,hwbinder,vndbinder" >/dev/null 2>&1 || true

# Persisted by writing files we own, rather than by appending to files we do
# not -- which is what makes re-running this safe.
mkdir -p /etc/modules-load.d /etc/modprobe.d
echo binder_linux >/etc/modules-load.d/magnemite.conf
echo 'options binder_linux devices=binder,hwbinder,vndbinder' >/etc/modprobe.d/magnemite.conf
step modules ok "$KERNEL"

# --- 3. check the outcome, not the step -------------------------------------
#
# Redroid's own documentation disagrees with itself about whether a modern
# kernel needs the module at all, so what gets verified is the end state: are
# the devices Android will ask for there, and can the processes that need them
# actually open them.
#
# "There" was once the whole check, and it is not enough -- which cost a night.
# modprobe creates these 0600 root:root, Android runs its services as uid 1000,
# 1013 and friends, and a privileged container inherits the mode. So every
# non-root service aborted on the open with
#
#     Binder driver could not be opened. Terminating.
#
# and the container sat at 4% CPU with 115 processes, never reaching
# sys.boot_completed. From the outside that is indistinguishable from a slow
# boot: docker says Up, docker logs says nothing (Android logs to logcat), and
# the machine reports a container that is running and a box that never enrols.
BINDER_DEVS="/dev/binder /dev/hwbinder /dev/vndbinder"

missing=""
for dev in $BINDER_DEVS; do
	[ -c "$dev" ] || missing="$missing $dev"
done
if [ -n "$missing" ]; then
	# Deliberately no longer satisfied by binderfs alone. A kernel that offers
	# only binderfs has no device for the rendered compose to hand a container,
	# and passing here would buy a machine that provisions cleanly and boots
	# nothing -- the failure this stage exists to prevent.
	die binder "no binder devices:$missing (modprobe binder_linux devices=binder,hwbinder,vndbinder)"
fi

# Now, for this boot...
chmod 0666 $BINDER_DEVS 2>/dev/null || true

# ...and for every boot after it. A file we own, overwritten rather than
# appended to, like the modprobe drop-ins above. Without this the modes go back
# to 0600 on the next reboot or module reload, and the fleet comes back from a
# kernel update with every container wedged at the same place -- with nothing
# to connect it to the reboot, because the containers *are* running.
mkdir -p /etc/udev/rules.d
cat >/etc/udev/rules.d/99-magnemite-binder.rules <<'RULES'
# Android's services do not run as root, and binder is opened by all of them.
SUBSYSTEM=="misc", KERNEL=="binder", MODE="0666"
SUBSYSTEM=="misc", KERNEL=="hwbinder", MODE="0666"
SUBSYSTEM=="misc", KERNEL=="vndbinder", MODE="0666"
RULES
if have udevadm; then
	udevadm control --reload-rules >/dev/null 2>&1 || true
	udevadm trigger --subsystem-match=misc >/dev/null 2>&1 || true
fi

# The check that actually matters, made against the mode rather than against
# the file existing. Read as "could a service that is not root open this".
for dev in $BINDER_DEVS; do
	mode=$(stat -c %a "$dev" 2>/dev/null || echo "")
	case "$mode" in
	*6 | *7) ;;
	*) die binder "$dev is mode ${mode:-unknown}; Android's services cannot open it" ;;
	esac
done
step binder ok "$(stat -c %a /dev/binder 2>/dev/null || echo unknown)"

# --- 3b. pid_max, set here rather than left as a side effect ----------------
#
# Every Redroid container writes 65535 into /proc/sys/kernel/pid_max at boot:
# the Android 11 image's own init does it for a multilib zygote, /proc/sys is
# not namespaced, and a privileged container sits in the initial user namespace.
# So a box silently changes a setting for the whole machine and everything else
# running on it.
#
# Redroid genuinely needs it below 65536, so the value is not the problem --
# being a surprise is. Setting it here, persistently, makes it a decision
# somebody can see in a file rather than a mystery discovered later.
if [ -w /proc/sys/kernel/pid_max ]; then
	echo 65535 >/proc/sys/kernel/pid_max 2>/dev/null || true
fi
mkdir -p /etc/sysctl.d
echo 'kernel.pid_max = 65535' >/etc/sysctl.d/99-magnemite-redroid.conf
step pidmax ok "$(cat /proc/sys/kernel/pid_max 2>/dev/null || echo unknown)"

# --- 4. docker --------------------------------------------------------------
#
# Two requirements, not one: an engine, and compose *v2* as a CLI plugin
# (`docker compose`). They used to be a single `apt-get install docker.io
# docker-compose-v2`, which is how a paid arm64 VPS came back with nothing:
# **no Debian release has ever had a `docker-compose-v2` package**, apt refuses
# the whole transaction when one name is unknown, and the machine ended up with
# no docker at all under the message "could not install docker".
#
# Selecting the plugin by distro package name does not work either, and is
# worse than it looks: Debian 13 calls it `docker-compose`, which is the name
# Debian 12 uses for the *Python v1* tool that `docker compose` cannot use. On
# Ubuntu 22.04 `docker-compose-v2` exists only in `jammy-updates`, not the
# release pocket.
#
# So: Docker's own apt repository first, which is uniform across Debian 11-13
# and Ubuntu 22.04+ on arm64 and carries the engine, the plugin and buildx --
# and `docker build` in step 5b wants buildx. Distro packages second, the
# convenience script last. Success is judged by `docker compose version` and
# never by apt's exit code, and every attempt appends to one log the failure
# quotes from.
DOCKER_LOG=/tmp/magnemite-docker.log
: >"$DOCKER_LOG"

compose_ok() { docker compose version >/dev/null 2>&1; }

# Recommends stay on, deliberately: Debian's `docker.io` only *recommends*
# `docker-cli`, so --no-install-recommends would install a daemon with no
# `docker` binary at all.
apt_do() { $APT -y -q "$@" >>"$DOCKER_LOG" 2>&1; }

# apt explains itself on lines starting `E:`; everything else is progress.
# A step line is one line, so this folds and clips -- the whole log stays on
# the machine at $DOCKER_LOG.
why() {
	w=$(sed -n 's/^E: //p' "$DOCKER_LOG" | tail -2)
	[ -n "$w" ] || w=$(grep -v '^[[:space:]]*$' "$DOCKER_LOG" | tail -2)
	printf '%s' "$w" | tr -d '\r' | tr '\n' ';' | cut -c1-160
}

if have docker && compose_ok; then
	step docker ok "$(docker --version 2>/dev/null | head -1)"
else
	have apt-get || die docker "docker is missing and this is not an apt machine"

	# Docker's own repository. Keyed by the *upstream* distro and codename, so a
	# derivative that puts its own name in VERSION_CODENAME still resolves.
	. /etc/os-release 2>/dev/null || true
	CODENAME=${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}
	case "${ID:-}:${ID_LIKE:-}" in
	ubuntu:* | *ubuntu*) FLAVOUR=ubuntu ;;
	debian:* | raspbian:* | *debian*) FLAVOUR=debian ;;
	*) FLAVOUR="" ;;
	esac

	if [ -n "$FLAVOUR" ] && [ -n "$CODENAME" ]; then
		apt_do install ca-certificates curl || true
		install -m 0755 -d /etc/apt/keyrings
		if curl -fsSL --retry 3 --retry-delay 2 \
			"https://download.docker.com/linux/$FLAVOUR/gpg" \
			-o /etc/apt/keyrings/docker.asc 2>>"$DOCKER_LOG"; then
			chmod a+r /etc/apt/keyrings/docker.asc
			printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
				"$(dpkg --print-architecture)" "$FLAVOUR" "$CODENAME" \
				>/etc/apt/sources.list.d/docker.list
			# Only this list, so an unrelated broken third-party repository
			# cannot decide whether docker gets installed.
			apt_do update \
				-o Dir::Etc::sourcelist=sources.list.d/docker.list \
				-o Dir::Etc::sourceparts=- \
				-o APT::Get::List-Cleanup=0 || true
			apt_do install docker-ce docker-ce-cli containerd.io \
				docker-compose-plugin docker-buildx-plugin || true
		fi
	fi

	# The distro's own, for a machine that cannot reach download.docker.com.
	# `docker.io` is the one name every Debian and Ubuntu agrees on.
	have docker || apt_do install docker.io || true

	# Last: Docker's convenience script. Last rather than first because it runs
	# a downloaded script as root, sleeps for twenty seconds when it finds an
	# existing install, and its own header says it is not for production -- but
	# it does carry engine and plugin together, which is what is wanted here.
	if ! have docker || ! compose_ok; then
		if curl -fsSL -o /tmp/get-docker.sh https://get.docker.com 2>>"$DOCKER_LOG"; then
			sh /tmp/get-docker.sh >>"$DOCKER_LOG" 2>&1 || true
		fi
	fi

	have docker || die docker "could not install docker: $(why)"
	compose_ok || die docker "docker is installed, the compose v2 plugin is not: $(why)"
	step docker ok "$(docker --version 2>/dev/null | head -1)"
fi

# --- 5. swap, sized to RAM --------------------------------------------------
#
# The one stage needing a real guard, because both the file and its fstab line
# must not be created twice. Worth doing: many workers on one machine is where
# a VPS runs out of RAM, and swap is what stands between that and the OOM
# killer taking a container down mid-scan. It costs speed, not boxes.
SWAPFILE=/swapfile
if [ "$(awk '/^SwapTotal:/ {print $2}' /proc/meminfo)" -gt 0 ] 2>/dev/null; then
	step swap ok "already configured"
elif [ -e "$SWAPFILE" ]; then
	# Present but not on: a previous run that stopped between creating it and
	# swapping it on.
	swapon "$SWAPFILE" 2>/dev/null || true
	step swap ok "existing $SWAPFILE"
else
	MEM_KB=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
	if fallocate -l "${MEM_KB}K" "$SWAPFILE" 2>/dev/null ||
		dd if=/dev/zero of="$SWAPFILE" bs=1024 count="$MEM_KB" >/dev/null 2>&1; then
		chmod 600 "$SWAPFILE"
		mkswap "$SWAPFILE" >/dev/null 2>&1
		swapon "$SWAPFILE" 2>/dev/null || true
		grep -q "^$SWAPFILE " /etc/fstab 2>/dev/null ||
			echo "$SWAPFILE none swap sw 0 0" >>/etc/fstab
		step swap ok "$((MEM_KB / 1024)) MiB"
	else
		# Not fatal. A machine without swap runs; it just reaches the OOM
		# killer sooner, and the dashboard shows swapTotalBytes as a real zero
		# rather than as "has not said".
		step swap warn "could not create $SWAPFILE"
	fi
fi

# --- 5b. the Redroid image --------------------------------------------------
#
# Built here rather than pulled, because there is nothing to pull from: the tag
# is local and this project publishes no registry. Without this step a freshly
# provisioned machine enrols, reports, and then fails its first converge with
# "pull access denied" on an image that was never going to exist.
#
# It is the same build `make redroid` does -- the base image plus the agent
# binary, the start script and the init service -- and it is skipped when the
# tag is already there, so re-running this is cheap.
if [ -n "${MAGNEMITE_IMAGE:-}" ] && [ -d ./redroid ]; then
	if docker image inspect "$MAGNEMITE_IMAGE" >/dev/null 2>&1; then
		step image ok "$MAGNEMITE_IMAGE already built"
	else
		# The build context is this directory: the Dockerfile copies
		# bin/magnemite-agent-linux-arm64 and redroid/*, so the binary has to
		# sit where it expects rather than where it was pushed.
		mkdir -p ./bin
		# Guarded, and that guard is the difference between this step warning
		# and the whole script dying two steps early. `set -e` is on, a failed
		# cp exits 1, and the binary is not always beside the script: a re-run
		# over the agent's socket sends no binary, because the machine already
		# has one and the agent updates itself. Without this, a re-run that has
		# to *build* a tag -- which is the re-run an image bump needs -- never
		# reaches `docker build`, never prints an image step, and stops before
		# the stages after it.
		if [ -f "$AGENT_BIN" ]; then
			cp "$AGENT_BIN" ./bin/magnemite-agent-linux-arm64
		fi
		if docker build -f ./redroid/Dockerfile -t "$MAGNEMITE_IMAGE" . >/tmp/magnemite-build.log 2>&1; then
			step image ok "built $MAGNEMITE_IMAGE"
		else
			# Not fatal to the bootstrap: the machine is otherwise ready and
			# will enrol. The converge is what fails, and it says why -- which
			# is a better place to find out than here, where the operator is
			# not watching a 780 MB pull.
			step image warn "could not build $MAGNEMITE_IMAGE (see /tmp/magnemite-build.log)"
		fi
	fi
else
	step image warn "no image build requested"
fi

# --- 5c. the hardening a public machine wants -------------------------------
#
# A Redroid host is unusually easy to lock down, because nothing on it
# listens: the rendered compose publishes no ports and the agent dials out, so
# the only thing that ever needs to reach this machine is whoever holds the SSH
# key. What is deliberately *not* done is at the bottom of this file, and
# unattended-upgrades in particular would do real harm here.
HARDEN_LOG=/tmp/magnemite-harden.log
: >"$HARDEN_LOG"
harden() { "$@" >>"$HARDEN_LOG" 2>&1; }

# Which port stays open. Hardcoding 22 on a machine whose sshd listens
# elsewhere locks the operator out of their own VPS halfway through
# provisioning it -- so the hub passes the port this connection actually came
# in on, and sshd's own config is read as well for the by-hand path, where
# nothing passes anything. Every port any of them names is allowed: a spare
# rule costs nothing and a missing one costs the machine.
SSH_PORTS=$(
	{
		printf '%s\n' "${MAGNEMITE_SSH_PORT:-}"
		# Resolved config first -- it is the only source that accounts for
		# drop-ins, which is where a cloud image usually puts its changes.
		sshd -T 2>/dev/null || /usr/sbin/sshd -T 2>/dev/null || true
		awk '$1 == "Port" { print $2 }' /etc/ssh/sshd_config 2>/dev/null
		awk '$1 == "Port" { print $2 }' /etc/ssh/sshd_config.d/*.conf 2>/dev/null
	} | awk '
		$1 == "port" { print $2 }
		$1 ~ /^[0-9]+$/ { print $1 }
	' | sort -un
)
[ -n "$SSH_PORTS" ] || SSH_PORTS=22
PORT_LIST=$(printf '%s' "$SSH_PORTS" | tr '\n' ',')

if have apt-get; then
	$APT -y -q install ufw fail2ban ca-certificates curl >>"$HARDEN_LOG" 2>&1 || true
fi

if have ufw; then
	# Outbound is how everything here works -- the agent dials the hub, docker
	# pulls, apt updates -- so only incoming is denied.
	harden ufw default deny incoming || true
	harden ufw default allow outgoing || true
	for p in $SSH_PORTS; do
		harden ufw allow "$p"/tcp || true
	done
	# --force, because `ufw enable` asks "this may disrupt existing ssh
	# connections" on a terminal and this script has none: without it the
	# bootstrap stops on a prompt nobody can answer.
	harden ufw --force enable || true
	FIREWALL="ufw, ssh on $PORT_LIST"
else
	# Not fatal, and not worth installing a second firewall for: a machine that
	# listens on nothing but sshd is not wide open, it is just not narrowed.
	FIREWALL="no ufw"
fi

if have fail2ban-server; then
	# A file we own, overwritten rather than appended to, like the modprobe
	# drop-ins in step 3. Two things have to be in it:
	#
	#   port     the jail's default is `ssh`, which /etc/services maps to 22 --
	#            so on a machine with sshd elsewhere it would watch a port
	#            nothing is attacking and ban on a port nobody uses.
	#   backend  Debian 12 and later ship no /var/log/auth.log, and the jail
	#            fails to start looking for it. journald is there by
	#            definition on a machine that has just been given a unit file.
	mkdir -p /etc/fail2ban/jail.d
	cat >/etc/fail2ban/jail.d/magnemite.conf <<CONF
[sshd]
enabled = true
backend = systemd
port = $PORT_LIST
CONF
	harden systemctl enable fail2ban || true
	harden systemctl restart fail2ban || true
	BANS="fail2ban"
else
	BANS="no fail2ban"
fi

# A drifted clock breaks TLS before it breaks anything else, and the symptom is
# an agent that cannot finish a handshake -- which reads as a network fault and
# is not one. Usually already on in a cloud image; this makes sure.
if have timedatectl; then
	harden timedatectl set-ntp true || true
fi

step harden ok "$FIREWALL, $BANS"

# --- 6. the agent, its config and its unit ----------------------------------
#
# Skipped whole when the agent is the one running this.
#
# A re-run over the socket comes from the agent itself, and three things in
# here are wrong in that case. There is no binary beside the script -- the
# agent updates itself over /files/*, so none is sent and the check below would
# `die` on every re-run. The config is already written and must not be touched.
# And the restart at the end would stop the service whose cgroup this script is
# running in: systemd would kill the run mid-way, and the result would never
# reach the hub that asked for it.
#
# The copy of the script is still refreshed below, which is the one part of
# this step a re-run genuinely wants.
if [ -n "${MAGNEMITE_SKIP_AGENT:-}" ]; then
	mkdir -p "$LIB_DIR"
	[ "$(readlink -f "$0" 2>/dev/null || echo "$0")" = "$LIB_DIR/bootstrap.sh" ] ||
		install -m 0755 "$0" "$LIB_DIR/bootstrap.sh" 2>/dev/null || true
	step agent ok "left running (re-run)"
	step done ok "the machine is as this script leaves it"
	exit 0
fi

[ -f "$AGENT_BIN" ] || die agent "no agent binary at $AGENT_BIN"
install -D -m 0755 "$AGENT_BIN" "$INSTALL_BIN"
mkdir -p "$LIB_DIR"
# Kept so the agent can re-run it on command from the hub, over the socket it
# already has -- no SSH, no credential. That is what covers the kernel trap:
# linux-modules-extra is per kernel version, so an apt upgrade that installs a
# new kernel leaves binder behind and every container fails after the reboot.
# Guarded, because on a re-run $0 may already *be* that file and install
# refuses to copy a file over itself.
[ "$(readlink -f "$0" 2>/dev/null || echo "$0")" = "$LIB_DIR/bootstrap.sh" ] ||
	install -m 0755 "$0" "$LIB_DIR/bootstrap.sh" 2>/dev/null || true

mkdir -p "$CONF_DIR"
chmod 700 "$CONF_DIR"
if [ -f "$CONF" ]; then
	# Re-run on an enrolled machine: its config holds a device token now, and
	# rewriting it would make the machine enroll again as a second row.
	step config ok "kept existing"
else
	: "${MAGNEMITE_SERVER:?MAGNEMITE_SERVER is required}"
	: "${MAGNEMITE_SERIAL:?MAGNEMITE_SERIAL is required}"
	umask 077
	cat >"$CONF" <<JSON
{
  "serverUrl": "$MAGNEMITE_SERVER",
  "serial": "$MAGNEMITE_SERIAL",
  "name": "${MAGNEMITE_NAME:-}",
  "enrollmentToken": "${MAGNEMITE_TOKEN:-}"
}
JSON
	chmod 600 "$CONF"
	step config ok "wrote $CONF"
fi

cat >"$UNIT" <<UNITFILE
[Unit]
Description=Magnemite host agent
Documentation=https://github.com/Rodaviva29/magnemite
# Containers are what this machine is for, and the agent converges them --
# so it waits for docker rather than racing it.
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
# Belt to the udev rule's braces, and the one that is certain to run: the
# containers do not come back by themselves after a reboot (restart: on-failure,
# so that N Androids do not start at once), the agent brings them up -- which
# makes this the last moment before anything needs binder. A machine whose udev
# never applied the rule would otherwise come back from a kernel update with
# every container wedged on an open() nobody is watching.
ExecStartPre=-/bin/sh -c 'chmod 0666 /dev/binder /dev/hwbinder /dev/vndbinder 2>/dev/null || true'
ExecStart=$INSTALL_BIN -host -config $CONF
# The agent dials out and retries with backoff on its own, so a restart here is
# only for a process that died outright.
Restart=always
RestartSec=10
# It logs to stderr, which journald takes from here.
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITFILE

systemctl daemon-reload
systemctl enable magnemite-host.service >/dev/null 2>&1 || true
systemctl restart magnemite-host.service
step agent ok "$INSTALL_BIN"

# Deliberately not "bootstrap ok": this script finishing proves the machine was
# prepared, not that it works. The proof is the agent dialing in, which the hub
# watches for -- the same rule the agent's own self-update follows, where the
# fresh `hello` is what confirms it. A stage here may have installed a kernel
# module that needs a reboot, after which SSH is gone and the only evidence
# left is the socket.
step done ok "waiting for the agent to reach the hub"

# --- what is deliberately not here ------------------------------------------
#
# Three things off the usual VPS checklist are missing on purpose, so that
# nobody adds them back believing they were forgotten.
#
# **unattended-upgrades**, which on *this* machine is actively harmful.
# linux-modules-extra is per kernel version (step 2), so an unattended upgrade
# that installs a new kernel leaves binder behind -- and after the next reboot
# every container fails to come up, with nothing in Magnemite to explain it,
# because the containers are simply gone. The replacement is the hub's "re-run
# bootstrap", which reaches this file over the agent's own socket and installs
# the modules for the kernel that is actually running.
#
# **A full `apt upgrade`**, the same hazard with worse timing: it can stage a
# new kernel while the old one is still running, so the modules installed
# moments ago in step 2 are for a kernel this machine is about to stop using.
#
# **Ports 80 and 443.** Nothing here serves HTTP. The dashboard and the hub are
# somewhere else entirely, and this machine only ever dials out to them.
#
# And one thing ufw does not cover, worth knowing before someone publishes a
# port to debug a container: Docker writes its own iptables rules, and a
# published container port bypasses ufw completely. Moot today, because the
# rendered compose publishes nothing -- which is exactly why the firewall can
# be this tight.
