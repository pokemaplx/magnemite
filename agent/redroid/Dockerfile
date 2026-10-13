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

# Magisk-prerooted, because Cosmog needs Magisk -- hidden from its worker
# processes -- and upstream Redroid ships none.
ARG REDROID=abing7k/redroid:a11_magisk_arm

# Magisk's own busybox, which the scanner's injector calls by absolute path --
# and which this image's Magisk gives root without ever installing: that
# directory is empty on a fresh box.
#
# Pinned, because this is the build proven on a box, and fetched here rather
# than vendored so the repo holds no 1.7 MB binary. A stage of its own because
# the base image is an Android system with no /bin/sh, so it cannot run a RUN
# layer -- the same reason every COPY below carries --chmod.
#
# Deliberately not executed to verify it: this is built against bionic for
# Android, and whether it happens to run under musl says nothing about whether
# it runs where it is going.
ARG MAGISK=v30.7
FROM alpine:3.20 AS busybox
ARG MAGISK
RUN apk add --no-cache curl unzip \
	&& curl -fsSL -o /tmp/magisk.apk \
		"https://github.com/topjohnwu/Magisk/releases/download/${MAGISK}/Magisk-${MAGISK}.apk" \
	&& unzip -o /tmp/magisk.apk 'lib/arm64-v8a/libbusybox.so' -d /tmp/magisk \
	&& test -s /tmp/magisk/lib/arm64-v8a/libbusybox.so

FROM ${REDROID}

# arm64 only, deliberately: the fleet's .apkm bundles carry an arm64-v8a split
# and the agent picks a split by exact ABI match. An x86_64 Redroid would need
# ARM translation and a different split policy.
#
# `_arm` in that tag is the *host* architecture, not a 32-bit guest -- the
# image is linux/arm64, which is why the arm64 binary below is still the right
# one. The `_amd` tags are the x86_64 variants, and `a11_magisk_ndk_arm` does
# not exist because `ndk` is the ARM native bridge an ARM host has no use for.
#
# --chmod rather than RUN chmod: the base image is an Android system, not a
# Linux distribution, and has no /bin/sh for a RUN layer to use.
COPY --chmod=0755 bin/magnemite-agent-linux-arm64 /system/bin/magnemite-agent
COPY --chmod=0755 redroid/magnemite-start.sh /system/bin/magnemite-start.sh

# Seeded into /data at boot by the start script, for the same reason the agent
# binary is: /data is a volume, so nothing this image puts there survives.
COPY --from=busybox --chmod=0755 \
	/tmp/magisk/lib/arm64-v8a/libbusybox.so /system/bin/magnemite-busybox

# Run by the agent after every install. Installing is what breaks root: Magisk
# keys its policy on the uid, a fresh install changes it, and a prompt nobody
# can answer is written down as a deny.
COPY --chmod=0755 redroid/magnemite-root-grant.sh /system/bin/magnemite-root-grant

# init reads every .rc under this directory at boot.
COPY --chmod=0644 redroid/magnemite.rc /system/etc/init/magnemite.rc
