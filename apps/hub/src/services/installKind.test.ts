import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COSMOG_PACKAGE,
  GAME_PACKAGE,
  cosmogPrefix,
  isCosmogBundle,
  versionFromFilename,
} from "@magnemite/apk";
import { installKind } from "./installKind.js";

const names = (...list: string[]) => list.map((name) => ({ name }));

test("cosmog is unpacked, on any box", () => {
  assert.equal(installKind(COSMOG_PACKAGE, COSMOG_PACKAGE), "cosmog");
  assert.equal(installKind(COSMOG_PACKAGE, null), "cosmog");
  assert.equal(installKind(COSMOG_PACKAGE, "com.pokemod.aegis"), "cosmog");
});

test("the game is files on a cosmog box and an app everywhere else", () => {
  assert.equal(installKind(GAME_PACKAGE, COSMOG_PACKAGE), "cosmog_game");
  assert.equal(installKind(GAME_PACKAGE, "com.pokemod.aegis"), null);
  assert.equal(installKind(GAME_PACKAGE, null), null);
});

test("anything else on a cosmog box is still an apk", () => {
  assert.equal(installKind("com.example.launcher", COSMOG_PACKAGE), null);
});

test("a cosmog bundle is the binary and its libart", () => {
  assert.equal(isCosmogBundle(names("com.nianticlabs.pokemongo", "lib/libart.so")), true);
  assert.equal(
    cosmogPrefix(names("cosmog/com.nianticlabs.pokemongo", "cosmog/lib/libart.so")),
    "cosmog/",
  );
});

test("half a bundle is not one", () => {
  assert.equal(isCosmogBundle(names("com.nianticlabs.pokemongo")), false);
  assert.equal(isCosmogBundle(names("lib/libart.so")), false);
  // The binary in one directory and the lib in another is two halves.
  assert.equal(isCosmogBundle(names("a/com.nianticlabs.pokemongo", "lib/libart.so")), false);
  assert.equal(isCosmogBundle(names("a/b/com.nianticlabs.pokemongo", "a/b/lib/libart.so")), false);
});

test("the game's own bundle is not a cosmog bundle", () => {
  assert.equal(isCosmogBundle(names("base.apk", "split_config.arm64_v8a.apk", "info.json")), false);
  assert.equal(isCosmogBundle(names("AndroidManifest.xml", "lib/arm64-v8a/libart.so")), false);
});

test("a version is read off a filename that has one", () => {
  assert.equal(versionFromFilename("cosmog-2.1.3.zip"), "2.1.3");
  assert.equal(versionFromFilename("cosmog_v2.2.1.zip"), "2.2.1");
  assert.equal(versionFromFilename("cosmog-2.1.3-beta2.zip"), "2.1.3-beta2");
  assert.equal(versionFromFilename("cosmog2.zip"), null);
  assert.equal(versionFromFilename("upload.apk"), null);
});
