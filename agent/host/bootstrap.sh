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
	apt-get update -qq >/dev/null 2>&1 || true
	# Not fatal on its own: a kernel with CONFIG_ANDROID_BINDERFS built in
	# needs no module at all, and the check below is what actually decides.
	apt-get install -y -qq "linux-modules-extra-$KERNEL" >/dev/null 2>&1 ||
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
# the devices Android will ask for actually there.
if [ -e /dev/binder ] || [ -d /dev/binderfs ] || grep -q binder /proc/filesystems 2>/dev/null; then
	step binder ok
else
	die binder "no binder devices and no binderfs — this kernel cannot run Redroid"
fi

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
if have docker && docker compose version >/dev/null 2>&1; then
	step docker ok "$(docker --version 2>/dev/null | head -1)"
else
	if have apt-get; then
		apt-get install -y -qq docker.io docker-compose-v2 >/dev/null 2>&1 ||
			die docker "could not install docker"
	else
		die docker "docker is missing and this is not an apt machine"
	fi
	docker compose version >/dev/null 2>&1 || die docker "docker compose v2 plugin is missing"
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
		cp "$AGENT_BIN" ./bin/magnemite-agent-linux-arm64
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

# --- 6. the agent, its config and its unit ----------------------------------
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
