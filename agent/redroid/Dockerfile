# syntax=docker/dockerfile:1
#
# The Redroid counterpart of the Magisk module zip: this image *is* the install.
# Build it with `make redroid`; each box is then one container of it, configured
# by the properties Redroid takes on the docker command line. Nothing here holds
# a token, so one image serves every fleet.
#
# Versioned by the `redroid=` line of VERSION, not the agent's: the binary below
# is a seed the box's own self-update replaces, so tying the tag to the agent
# would recreate every container on a machine for each agent release.
#
# Build context is agent/, so agent/bin/ and agent/redroid/ are both in scope.

# The official Redroid image, and **64-bit only** on purpose.
#
# An arm64 Android normally ships two zygotes, and the 32-bit one needs AArch32
# -- which Arm has been removing generation by generation. Neoverse N1 and V1
# (Ampere Altra, Graviton 2 and 3) still have it at EL0; V2 and V3 (Graviton 4
# and 5, Google Axion, NVIDIA Grace) and every Apple Silicon do not. There the
# 32-bit zygote cannot start, and the symptom is a container that runs with an
# Android that never finishes booting -- an instance left `running, not
# enrolled`, which reads like a network fault and is not one.
#
# A 64-only image removes the half that cannot run, and nothing is lost: the
# fleet's .apkm bundles carry an arm64-v8a split and the agent picks a split by
# exact ABI match, so no 32-bit runtime was ever used by anything here.
#
# The 64only variants start at Android 12, which is why this is 12 and not 11.
ARG REDROID=redroid/redroid:12.0.0_64only-latest

# Magisk, injected here rather than inherited from a prerooted base.
#
# This used to be `abing7k/redroid:a11_magisk_arm`, and that was a dead end:
# the image carries Magisk Delta 25206 canary from a 2023 androidfilehost
# mirror, Delta's own repositories are gone from GitHub, and the repo that
# built it says it is no longer maintained. Nobody can rebuild that image,
# including its author.
#
# So the injection is ours now, and it is the same one `ayasa520/redroid-script`
# performs -- the script abing7k forked, still maintained, and the source of
# every line of the init block below. Bootless Magisk is a handful of binaries
# under /system/etc/init/magisk plus a hook in bootanim.rc, so doing it here
# keeps the whole thing to one `docker build` on the machine: no python, no
# lzip, and no third-party script fetched while provisioning.
#
# One consequence worth knowing rather than discovering. This is not Delta, so
# hiding is Zygisk and the DenyList -- `zygisk=1` and a list of packages -- and
# not Delta's MagiskHide (`hide=1`), which no longer exists anywhere to install.
#
# And it is **not upstream either**, which is the part that cost a fleet its
# root. `--setup-sbin` and `--auto-selinux` -- on every line of the init block
# below -- are not Magisk features. They are carried by the fork the script
# downloads, whose branch is named `direct-system-install`, and upstream has
# never had them. Build this against topjohnwu/Magisk and the version number
# resolves, the apk unpacks, all three asserts below pass, and the box boots
# with no root at all: init runs `--setup-sbin`, Magisk answers "Unrecognized
# argument", /sbin/magisk is never created, and every later line in the hook
# calls a binary that is not there. There is no daemon to complain, so nothing
# in logcat says "no root" -- what the operator sees is the scanner injecting
# nothing, which is the same silence described under the grant below.
#
# So the owner of this URL is load-bearing, and the md5 is what keeps a bump
# honest: the flags have to come from the same tree as the init block.
#
# Pinned rather than latest, because it runs as root on every box -- and third
# party rather than upstream, which is worth a second thought on each bump.
ARG MAGISK=v30.7
ARG MAGISK_REPO=ayasa520/Magisk
ARG MAGISK_MD5=0a31050fdcfaa15f47c9dd1eb8d04fc8

# Only so a later stage can read files out of the base. Android is not a Linux
# distribution and has no /bin/sh, so nothing can be computed *in* the image --
# every byte has to arrive by COPY.
FROM ${REDROID} AS base

FROM alpine:3.20 AS magisk
ARG MAGISK
ARG MAGISK_REPO
ARG MAGISK_MD5

# The real one, rather than a copy written down here. It is byte-identical to
# the version the script hardcodes today, and reading it means a change
# upstream is inherited instead of silently overwritten.
COPY --from=base /system/etc/init/bootanim.rc /tmp/bootanim.rc

RUN apk add --no-cache curl unzip

RUN <<'SH'
set -eu

curl -fsSL -o /tmp/magisk.apk \
    "https://github.com/${MAGISK_REPO}/releases/download/${MAGISK}/Magisk-${MAGISK}.apk"

# What stops a bump from quietly swapping the tree the init block needs. The
# apk is downloaded over TLS from a tag, so this is not about interception --
# it is about a release that moved, or an owner swapped by hand while the md5
# below was left alone. Skipped when empty, so an experiment with another
# version is `--build-arg MAGISK=... --build-arg MAGISK_MD5=`.
if [ -n "${MAGISK_MD5:-}" ]; then
    echo "${MAGISK_MD5}  /tmp/magisk.apk" | md5sum -c -
fi

unzip -o /tmp/magisk.apk 'lib/arm64-v8a/*' -d /tmp/magisk

OUT=/out
mkdir -p "$OUT/system/etc/init/magisk" "$OUT/sbin"

# libmagisk.so becomes magisk, libmagiskpolicy.so becomes magiskpolicy, and so
# on -- the names the init block below calls. v30.7 ships one unified
# libmagisk.so, which is why that block runs `magisk` and not `magisk64`; a
# version that splits them again needs the block changed with it, so the three
# asserts below are what turns that into a failed build rather than a box that
# boots without root.
for so in /tmp/magisk/lib/arm64-v8a/lib*.so; do
    name=$(basename "$so" .so)
    install -m 0755 "$so" "$OUT/system/etc/init/magisk/${name#lib}"
done
test -x "$OUT/system/etc/init/magisk/magisk"
test -x "$OUT/system/etc/init/magisk/magiskpolicy"
test -x "$OUT/system/etc/init/magisk/busybox"

# And that the binary takes the flags the init block passes it, which the three
# asserts above never checked -- they check that a file called `magisk` exists,
# and upstream's is called that too. That gap is the whole bug: a build against
# the wrong owner passed every test here and shipped an image that could not
# root a single box.
#
# Grepped rather than run. These are Android arm64 binaries and this stage is
# whatever the build host is, so `magisk --help` is not available to ask -- but
# an argument parser has to carry its own flag names as strings, so their
# absence is as legible in the binary as in the help text.
#
# Both, because they fail differently and only one of them is loud: without
# `--setup-sbin` there is no /sbin/magisk and nothing roots, while
# `--auto-selinux` missing would leave the execs running under whatever context
# init gave them.
for flag in setup-sbin auto-selinux; do
    grep -qa "$flag" "$OUT/system/etc/init/magisk/magisk" || {
        echo "this Magisk build has no --$flag, so the bootanim.rc hook below" >&2
        echo "cannot work: ${MAGISK_REPO} ${MAGISK} is not the patched tree the" >&2
        echo "init block is written for (upstream has never carried these)." >&2
        exit 1
    }
done

# The app installs itself on first boot, from here.
install -m 0644 /tmp/magisk.apk "$OUT/system/etc/init/magisk/magisk.apk"

# Updating Magisk from the app rewrites bootanim.rc, and this is the copy it
# restores from. Not decoration: without it an in-app update can leave a box
# with no way back to an init that boots.
gzip -c /tmp/bootanim.rc >"$OUT/system/etc/init/bootanim.rc.gz"
chmod 0644 "$OUT/system/etc/init/bootanim.rc.gz"

# The hook itself, appended to the real file. Every `exec` here is Magisk's own
# startup sequence; the package checked on the last one is upstream's, where
# the script still names Delta's and therefore reinstalls on every boot.
cp /tmp/bootanim.rc "$OUT/system/etc/init/bootanim.rc"
cat >>"$OUT/system/etc/init/bootanim.rc" <<'RC'

on post-fs-data
    start logd
    exec u:r:su:s0 root root -- /system/etc/init/magisk/magiskpolicy --live --magisk
    exec u:r:magisk:s0 root root -- /system/etc/init/magisk/magiskpolicy --live --magisk
    exec u:r:update_engine:s0 root root -- /system/etc/init/magisk/magiskpolicy --live --magisk
    exec u:r:su:s0 root root -- /system/etc/init/magisk/magisk --auto-selinux --setup-sbin /system/etc/init/magisk /sbin
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --post-fs-data

on nonencrypted
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --service

on property:vold.decrypt=trigger_restart_framework
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --service

on property:sys.boot_completed=1
    mkdir /data/adb/magisk 755
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --boot-complete
    exec -- /system/bin/sh -c "if [ ! -e /data/data/com.topjohnwu.magisk ] ; then pm install /system/etc/init/magisk/magisk.apk ; fi"

on property:init.svc.zygote=restarting
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --zygote-restart

on property:init.svc.zygote=stopped
    exec u:r:su:s0 root root -- /sbin/magisk --auto-selinux --zygote-restart
RC
chmod 0644 "$OUT/system/etc/init/bootanim.rc"
SH

FROM ${REDROID}

# Magisk's tree, modes carried over from the stage that built it.
COPY --from=magisk /out/ /

# arm64 only, deliberately: the fleet's .apkm bundles carry an arm64-v8a split
# and the agent picks a split by exact ABI match. An x86_64 Redroid would need
# ARM translation and a different split policy.
#
# --chmod rather than RUN chmod: the base image is an Android system, not a
# Linux distribution, and has no /bin/sh for a RUN layer to use.
COPY --chmod=0755 bin/magnemite-agent-linux-arm64 /system/bin/magnemite-agent
COPY --chmod=0755 redroid/magnemite-start.sh /system/bin/magnemite-start.sh

# Seeded into /data at boot by the start script, for the same reason the agent
# binary is: /data is a volume, so nothing this image puts there survives.
#
# The scanner's injector calls /data/adb/magisk/busybox by absolute path and
# needs an applet Android's toybox does not have, so the seed is Magisk's own
# busybox -- taken from the tree above rather than downloaded a second time.
COPY --from=magisk --chmod=0755 \
    /out/system/etc/init/magisk/busybox /system/bin/magnemite-busybox

# Run by the agent after every install. Installing is what breaks root: Magisk
# keys its policy on the uid, a fresh install changes it, and a prompt nobody
# can answer is written down as a deny.
COPY --chmod=0755 redroid/magnemite-root-grant.sh /system/bin/magnemite-root-grant

# init reads every .rc under this directory at boot.
COPY --chmod=0644 redroid/magnemite.rc /system/etc/init/magnemite.rc
