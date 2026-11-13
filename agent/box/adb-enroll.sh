#!/bin/sh
# Enrolls hardware Android TV boxes into the fleet over adb.
#
# This is the one time each box needs anything pointed *at* it. After it
# reboots, the agent dials out to the hub on its own and every later update
# goes over that socket -- no adb, no LAN access, no port forwarding.
#
# Run two ways, and that is the whole reason this is a script rather than
# TypeScript:
#
#   - by the hub, in its own container, when the hub shares a LAN with the
#     boxes (a self-hosted hub, or development);
#   - by the agent on a machine, over the socket that machine already holds,
#     when it does not -- which is the normal case, because a hub on a VPS
#     cannot reach 192.168.1.10:5555.
#
# One copy, one set of quirks, one place to fix them.
#
# Every stage prints `::step <name> <ok|warn|fail> [detail]` on stdout, parsed
# by the same parser the host bootstrap uses. The probe also prints
# `::fact <address> <key> <value...>` -- fixed leading fields and a free-text
# tail, because `ro.product.model` is routinely "Chromecast with Google TV"
# and `key=value` pairs would break on the spaces. An address of `-` means the
# fact is about the run rather than about a box.
#
# Input arrives in an environment the caller sourced from a 0600 file and
# deleted: an enrollment token in argv is world-readable through
# /proc/<pid>/cmdline for as long as the run takes.
#
#   MAGNEMITE_MODE=probe|enroll
#   MAGNEMITE_ADDRESSES   newline-separated, probe mode
#   MAGNEMITE_TARGETS     newline-separated `address<TAB>serial<TAB>token`,
#                         enroll mode; an empty serial means "let the box use
#                         its own ro.serialno"
#   MAGNEMITE_SERVER      hub URL written into the box's config
#   MAGNEMITE_ZIP         path to the Magisk module zip, enroll mode
#   MAGNEMITE_REBOOT      1 (default) or 0
#   MAGNEMITE_REPROVISION 1 to overwrite a box that is already enrolled
#   MAGNEMITE_ADB_HOME    where adb keeps its identity; see "the key" below
#
# POSIX sh, not bash: this runs under busybox ash in the hub's Alpine image
# *and* under dash on a Debian machine, and the two disagree about more than
# you would like. Three of those disagreements are load-bearing and commented
# where they bite.

set -eu

MODE=${MAGNEMITE_MODE:-probe}
SERVER=${MAGNEMITE_SERVER:-}
ZIP=${MAGNEMITE_ZIP:-}
REBOOT=${MAGNEMITE_REBOOT:-1}
REPROVISION=${MAGNEMITE_REPROVISION:-0}
BATCH=${MAGNEMITE_BATCH:-32}
CONNECT_TIMEOUT=${MAGNEMITE_CONNECT_TIMEOUT:-2}

DATADIR=/data/adb/magnemite
PUSHDIR=/data/local/tmp

step() { printf '::step %s %s %s\n' "$1" "$2" "${3:-}"; }
fact() { printf '::fact %s %s %s\n' "$1" "$2" "${3:-}"; }

die() {
	step "$1" fail "$2"
	echo "adb-enroll failed at $1: $2" >&2
	exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

have adb || die adb "adb is not on PATH"

# --- the adb server ---------------------------------------------------------
#
# `adb connect` forks a server daemon on :5037 that outlives this script and
# inherits whatever stdio it was started with. Started lazily from inside a
# command substitution, it holds the write end of the caller's pipe open after
# we exit, so Node's 'close' never fires and the run looks like it hung
# forever. Starting it here with its own redirections is what stops that; the
# caller also resolves on 'exit' rather than 'close', because belt and braces
# are cheap and this failure costs an afternoon.
#
# The server is deliberately *not* killed on the way out, which took one
# surprise to learn: it is global to the machine, so `adb kill-server` in a
# trap drops the adb session of whoever else is using it -- and in development
# that is the person debugging a box by hand while the hub runs beside them.
# What actually needs cleaning up is the connections, and every path below
# disconnects the address it opened. A server left running is free, and it
# keeps the auth state that makes the next run fast.
adb start-server >/dev/null 2>&1 </dev/null || die adb "could not start the adb server"

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t magnemite-adb)
trap 'rm -rf "$TMP"' EXIT

# --- the key ----------------------------------------------------------------
#
# adb identifies itself with $HOME/.android/adbkey, and the public half is what
# the "Always allow from this computer" box on the TV remembers. Lose it and
# every box in the fleet asks again, in a living room, where nobody is.
#
# ANDROID_USER_HOME is not the lever -- the SDK's Java tools honour it, the adb
# binary does not; it reads HOME and falls back to getpwuid_r. So HOME is what
# gets moved, and the caller passes somewhere that survives a container
# rebuild.
if [ -n "${MAGNEMITE_ADB_HOME:-}" ]; then
	HOME=$MAGNEMITE_ADB_HOME
	export HOME
fi
mkdir -p "$HOME/.android"
chmod 700 "$HOME/.android" 2>/dev/null || true
if [ ! -f "$HOME/.android/adbkey" ]; then
	adb keygen "$HOME/.android/adbkey" >/dev/null 2>&1 ||
		die adbkey "could not generate an adb key in $HOME/.android"
fi
if [ -f "$HOME/.android/adbkey.pub" ]; then
	# Reported so the hub can offer one combined adb_keys file for preseeding
	# into a golden image, which is what turns this from "tap Allow on each TV"
	# into something unattended.
	fact - adbPublicKey "$(tr -d '\n' <"$HOME/.android/adbkey.pub")"
fi

# Normalises a bare address to one with the default adb port.
with_port() {
	case "$1" in
	*:*) printf '%s' "$1" ;;
	*) printf '%s:5555' "$1" ;;
	esac
}

# Refuses anything that would break out of the single quotes the device-side
# `su -c` wraps around it. Nothing legitimate here contains one -- a token is
# base64url, a serial is alphanumeric, a URL has no business with quotes -- so
# this is cheap, and the alternative is a shell injection on a box that by
# definition has root.
safe() {
	case "$1" in
	*\'* | *\"* | *\$* | *\`* | *\;* | *\&* | *\|* | *\<* | *\>*) return 1 ;;
	esac
	return 0
}

# Connects, and says which of the three states came back.
#
# `adb connect` exiting zero proves nothing on its own: older builds return
# zero whatever happened, which is why the proven script greps the text. And a
# box that has never seen this key connects *fine* and then sits in
# `unauthorized` with a dialog on the TV -- a state that fails every later
# command with something that looks nothing like "go tap Allow".
connect_state() {
	addr=$1
	out=$(timeout "$CONNECT_TIMEOUT" adb connect "$addr" 2>&1 | tr -d '\r' || true)
	case "$out" in
	*"connected to"*) : ;;
	*)
		printf 'offline'
		return 0
		;;
	esac
	state=$(adb -s "$addr" get-state 2>&1 | tr -d '\r' | tail -n1)
	case "$state" in
	device) printf 'device' ;;
	*unauthorized*) printf 'unauthorized' ;;
	*) printf 'offline' ;;
	esac
}

# 0 when `su -c` works for the shell user, which is what Magisk has to have
# granted and the single most common reason this whole thing fails.
has_root() {
	adb -s "$1" shell 'su -c "id -u"' 2>/dev/null | tr -d '\r' | grep -q '^0$'
}

# True when the box already carries an agent config, which means it is enrolled
# and its identity is not ours to replace.
has_config() {
	adb -s "$1" shell "su -c 'test -f $DATADIR/config.json && echo yes || echo no'" 2>/dev/null |
		tr -d '\r' | grep -q '^yes$'
}

# ---------------------------------------------------------------------------
# probe -- the scanner. Reads, and writes nothing to any box.
# ---------------------------------------------------------------------------

probe_one() {
	addr=$1
	state=$(connect_state "$addr")
	fact "$addr" state "$state"
	if [ "$state" != device ]; then
		adb disconnect "$addr" >/dev/null 2>&1 || true
		return 0
	fi

	# One shell, six properties: a round trip per property over a LAN turns a
	# /24 sweep into minutes.
	props=$(adb -s "$addr" shell 'getprop ro.serialno; getprop ro.boot.serialno; getprop ro.product.model; getprop ro.product.manufacturer; getprop ro.product.cpu.abi; getprop ro.build.version.sdk' 2>/dev/null | tr -d '\r' || true)
	fact "$addr" serial "$(printf '%s\n' "$props" | sed -n '1p')"
	fact "$addr" bootSerial "$(printf '%s\n' "$props" | sed -n '2p')"
	fact "$addr" model "$(printf '%s\n' "$props" | sed -n '3p')"
	fact "$addr" manufacturer "$(printf '%s\n' "$props" | sed -n '4p')"
	fact "$addr" abi "$(printf '%s\n' "$props" | sed -n '5p')"
	fact "$addr" sdk "$(printf '%s\n' "$props" | sed -n '6p')"

	if has_root "$addr"; then
		fact "$addr" root yes
		if has_config "$addr"; then
			fact "$addr" enrolled yes
		else
			fact "$addr" enrolled no
		fi
	else
		fact "$addr" root no
		# Not "no". Without root we cannot read the config, and reporting a
		# box as un-enrolled when we simply could not look is how an operator
		# ends up re-provisioning a box that was working.
		fact "$addr" enrolled unknown
	fi

	adb disconnect "$addr" >/dev/null 2>&1 || true
}

# Probes up to $BATCH addresses at once, then prints their output in order.
#
# Each job writes to its own file rather than the shared stdout: 32 background
# jobs interleaving `::fact` lines produces output that parses into nonsense,
# and the corruption is intermittent enough to look like a device problem.
#
# Fixed batches followed by a bare `wait`, not a sliding window, because
# `wait -n` does not exist in dash -- and dash is /bin/sh on Debian, which is
# what runs this on a relay machine.
probe_batch() {
	n=0
	for addr in "$@"; do
		probe_one "$addr" >"$TMP/p$n.out" 2>/dev/null &
		n=$((n + 1))
	done
	wait
	i=0
	while [ "$i" -lt "$n" ]; do
		cat "$TMP/p$i.out" 2>/dev/null || true
		rm -f "$TMP/p$i.out"
		i=$((i + 1))
	done
}

run_probe() {
	[ -n "${MAGNEMITE_ADDRESSES:-}" ] || die probe "no addresses to probe"

	printf '%s\n' "$MAGNEMITE_ADDRESSES" >"$TMP/addresses"
	total=$(grep -c '[^[:space:]]' <"$TMP/addresses" || true)
	step probe ok "0/$total"

	# `set --` is the only list a POSIX shell has. The script takes no
	# positional arguments, so there is nothing to lose by using them.
	done_n=0
	set --
	while read -r line; do
		line=$(printf '%s' "$line" | tr -d '[:space:]')
		[ -n "$line" ] || continue
		set -- "$@" "$(with_port "$line")"
		if [ $# -ge "$BATCH" ]; then
			probe_batch "$@"
			done_n=$((done_n + $#))
			step probe ok "$done_n/$total"
			set --
		fi
	done <"$TMP/addresses"

	# Guarded, so a total that divides exactly by the batch size does not
	# report the last batch twice.
	if [ $# -gt 0 ]; then
		probe_batch "$@"
		done_n=$((done_n + $#))
		step probe ok "$done_n/$total"
	fi
	step done ok "probed $done_n"
}

# ---------------------------------------------------------------------------
# enroll -- the sequence that puts the agent on a box.
# ---------------------------------------------------------------------------

# Returns non-zero when this box did not make it, having already said why in a
# `::step`. One box failing must not stop the rest of the run.
enroll_one() {
	addr=$1
	serial=$2
	token=$3

	state=$(connect_state "$addr")
	case "$state" in
	device) step "$addr/connect" ok ;;
	unauthorized)
		step "$addr/connect" fail "adb is not authorised - accept the key on the TV, or preseed it into /data/misc/adb/adb_keys"
		return 1
		;;
	*)
		step "$addr/connect" fail "no answer - is adb over network on?"
		return 1
		;;
	esac

	if has_root "$addr"; then
		step "$addr/root" ok
	else
		step "$addr/root" fail "no root via su - is Magisk installed and su granted to shell?"
		adb disconnect "$addr" >/dev/null 2>&1 || true
		return 1
	fi

	if has_config "$addr"; then
		if [ "$REPROVISION" != 1 ]; then
			step "$addr/guard" fail "already enrolled - it has a config and keeps it; re-provision to replace"
			adb disconnect "$addr" >/dev/null 2>&1 || true
			return 1
		fi
		step "$addr/guard" warn "already enrolled - replacing its config"
		adb -s "$addr" shell "su -c 'rm -f $DATADIR/config.json'" >/dev/null 2>&1 || true
	fi

	# --- the config ---------------------------------------------------------
	#
	# Written *before* the module is installed, and that order is load-bearing:
	# customize.sh keeps an existing config and only installs a bundled one
	# when it finds none. Install first and this box keeps whatever it had,
	# which is right for an upgrade and wrong for an enrollment.
	#
	# Pushed as a file rather than written through a heredoc nested in
	# `su -c '...'`: the token would otherwise sit in the device shell's argv,
	# and quoting JSON through two shells is a thing to get wrong once and
	# debug for an hour. adb push carries the local mode, so it lands 0600 and
	# is never briefly world-readable in /data/local/tmp.
	if [ -n "$serial" ]; then
		printf '{"serverUrl":"%s","enrollmentToken":"%s","serial":"%s"}\n' \
			"$SERVER" "$token" "$serial" >"$TMP/config.json"
	else
		printf '{"serverUrl":"%s","enrollmentToken":"%s"}\n' \
			"$SERVER" "$token" >"$TMP/config.json"
	fi
	chmod 600 "$TMP/config.json"

	if ! adb -s "$addr" push "$TMP/config.json" "$PUSHDIR/magnemite-config.json" >/dev/null 2>&1; then
		rm -f "$TMP/config.json"
		step "$addr/config" fail "could not push the config"
		adb disconnect "$addr" >/dev/null 2>&1 || true
		return 1
	fi
	rm -f "$TMP/config.json"
	if ! adb -s "$addr" shell "su -c 'mkdir -p $DATADIR && chmod 700 $DATADIR && cp $PUSHDIR/magnemite-config.json $DATADIR/config.json && chmod 600 $DATADIR/config.json && rm -f $PUSHDIR/magnemite-config.json'" >/dev/null 2>&1; then
		step "$addr/config" fail "could not install the config"
		adb disconnect "$addr" >/dev/null 2>&1 || true
		return 1
	fi
	step "$addr/config" ok "serial ${serial:-from the box}"

	zipname=$(basename "$ZIP")
	if ! adb -s "$addr" push "$ZIP" "$PUSHDIR/$zipname" >/dev/null 2>&1; then
		step "$addr/push" fail "could not push the module"
		adb disconnect "$addr" >/dev/null 2>&1 || true
		return 1
	fi
	step "$addr/push" ok "$zipname"

	out=$(adb -s "$addr" shell "su -c 'magisk --install-module $PUSHDIR/$zipname'" 2>&1 | tr -d '\r' || true)
	adb -s "$addr" shell "su -c 'rm -f $PUSHDIR/$zipname'" >/dev/null 2>&1 || true
	case "$out" in
	*[Dd]one* | *[Ss]uccess* | *Installing*)
		step "$addr/install" ok
		;;
	*)
		step "$addr/install" fail "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-300)"
		adb disconnect "$addr" >/dev/null 2>&1 || true
		return 1
		;;
	esac

	# The module's service.sh only runs at boot, and Magisk stages into
	# modules_update and swaps on reboot -- so this is the step that makes the
	# install real, not a courtesy.
	if [ "$REBOOT" = 1 ]; then
		adb -s "$addr" reboot >/dev/null 2>&1 || true
		step "$addr/reboot" ok "it will dial in a minute or so after it boots"
	else
		step "$addr/reboot" warn "not rebooted - the agent starts on the next boot"
	fi

	adb disconnect "$addr" >/dev/null 2>&1 || true
	return 0
}

run_enroll() {
	[ -n "${MAGNEMITE_TARGETS:-}" ] || die enroll "no targets to enroll"
	[ -n "$SERVER" ] || die enroll "MAGNEMITE_SERVER is not set"
	[ -n "$ZIP" ] || die enroll "MAGNEMITE_ZIP is not set"
	[ -f "$ZIP" ] || die enroll "no module zip at $ZIP"
	safe "$SERVER" || die enroll "the server URL has characters that cannot be passed to a shell"

	printf '%s\n' "$MAGNEMITE_TARGETS" >"$TMP/targets"
	total=$(grep -c '[^[:space:]]' <"$TMP/targets" || true)

	# Sequential, unlike the probe, and on purpose. Each box takes a ~10 MiB
	# push, so running them together would contend for the same LAN while
	# hiding every `::step` behind a batch barrier -- and the progress is the
	# entire reason those lines exist. A dozen boxes is a few minutes, and the
	# operator gets to watch it happen.
	ok_n=0
	fail_n=0
	while IFS= read -r line; do
		[ -n "$(printf '%s' "$line" | tr -d '[:space:]')" ] || continue
		addr=$(with_port "$(printf '%s' "$line" | cut -f1)")
		serial=$(printf '%s' "$line" | cut -f2)
		token=$(printf '%s' "$line" | cut -f3)

		if ! safe "$addr" || ! safe "$serial" || ! safe "$token"; then
			step "$addr/connect" fail "refused: that target has characters that cannot be passed to a shell"
			fail_n=$((fail_n + 1))
			continue
		fi

		if enroll_one "$addr" "$serial" "$token"; then
			ok_n=$((ok_n + 1))
		else
			fail_n=$((fail_n + 1))
		fi
	done <"$TMP/targets"

	# Not `die`: a run where nine of ten boxes worked is not a failed run, and
	# the nine are enrolled whatever this line says. Which ones failed is in
	# their own steps.
	if [ "$fail_n" -gt 0 ]; then
		step done warn "$ok_n of $total enrolled, $fail_n failed"
	else
		step done ok "$ok_n of $total enrolled"
	fi
}

case "$MODE" in
probe) run_probe ;;
enroll) run_enroll ;;
*) die mode "unknown mode: $MODE" ;;
esac
