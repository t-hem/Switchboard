import assert from "node:assert/strict";
import test from "node:test";

import { ClaimRegistry, type EvictableSocket } from "../src/claim.ts";

function fakeSocket(): EvictableSocket & { reasons: string[] } {
  const reasons: string[] = [];
  return { reasons, evict: (reason: string) => reasons.push(reason) };
}

test("starts with no claimant", () => {
  assert.equal(new ClaimRegistry().current, null);
});

test("the first claim evicts nobody", () => {
  const r = new ClaimRegistry();
  const result = r.claim("a", "desktop", 1000);
  assert.equal(result.evicted, null);
  assert.deepEqual(result.claimant, { clientId: "a", clientLabel: "desktop", claimedAt: 1000 });
  assert.deepEqual(r.current, { clientId: "a", clientLabel: "desktop", claimedAt: 1000 });
});

test("re-claiming as the holder does not evict its own sockets", () => {
  const r = new ClaimRegistry();
  r.claim("a", "desktop", 1000);
  const socket = fakeSocket();
  r.register("a", "desktop", socket);

  // A client re-claims on every window focus; that must not disconnect it.
  const result = r.claim("a", "desktop", 2000);
  assert.equal(result.evicted, null);
  assert.deepEqual(socket.reasons, []);
  assert.equal(r.current?.claimedAt, 2000);
  assert.equal(r.socketCount("a"), 1);
});

test("re-claiming refreshes a changed label", () => {
  const r = new ClaimRegistry();
  r.claim("a", "desktop", 1000);
  r.claim("a", "workstation", 1100);
  assert.equal(r.current?.clientLabel, "workstation");
});

test("a new client evicts the previous one and severs its sockets", () => {
  const r = new ClaimRegistry();
  r.claim("a", "desktop", 1000);
  const first = fakeSocket();
  const second = fakeSocket();
  r.register("a", "desktop", first);
  r.register("a", "desktop", second);

  const result = r.claim("b", "phone", 2000);
  assert.deepEqual(result.evicted, { clientId: "a", clientLabel: "desktop", claimedAt: 1000 });
  assert.deepEqual(first.reasons, ["claimed by phone"]);
  assert.deepEqual(second.reasons, ["claimed by phone"]);
  assert.equal(r.socketCount("a"), 0);
});

test("eviction leaves the new claimant's own sockets alone", () => {
  const r = new ClaimRegistry();
  r.claim("a", "desktop", 1000);
  const theirs = fakeSocket();
  r.register("a", "desktop", theirs);
  const mine = fakeSocket();
  r.register("b", "phone", mine);

  r.claim("b", "phone", 2000);
  assert.deepEqual(theirs.reasons, ["claimed by phone"]);
  assert.deepEqual(mine.reasons, []);
  assert.equal(r.socketCount("b"), 1);
});

test("taking back evicts the client that took over", () => {
  const r = new ClaimRegistry();
  r.claim("a", "desktop", 1000);
  const desktop = fakeSocket();
  r.register("a", "desktop", desktop);

  r.claim("b", "phone", 2000);
  const phone = fakeSocket();
  r.register("b", "phone", phone);
  assert.deepEqual(desktop.reasons, ["claimed by phone"]);

  r.claim("a", "desktop", 3000);
  assert.deepEqual(phone.reasons, ["claimed by desktop"]);
  assert.equal(r.current?.clientId, "a");
});

test("a socket that throws on evict does not block the others", () => {
  const r = new ClaimRegistry();
  r.claim("a", "desktop", 1000);
  const exploding: EvictableSocket = { evict: () => { throw new Error("already closed"); } };
  const healthy = fakeSocket();
  r.register("a", "desktop", exploding);
  r.register("a", "desktop", healthy);

  r.claim("b", "phone", 2000);
  assert.deepEqual(healthy.reasons, ["claimed by phone"]);
});

test("mayAttach: anyone may attach to an unclaimed host", () => {
  const r = new ClaimRegistry();
  assert.equal(r.mayAttach("anyone"), true);
});

test("mayAttach: only the claimant may attach once claimed", () => {
  const r = new ClaimRegistry();
  r.claim("a", "desktop", 1000);
  assert.equal(r.mayAttach("a"), true);
  assert.equal(r.mayAttach("b"), false);
});

test("mayAttach: an empty client id is never allowed", () => {
  const r = new ClaimRegistry();
  assert.equal(r.mayAttach(""), false);
  r.claim("a", "desktop", 1000);
  assert.equal(r.mayAttach(""), false);
});

test("registering on an unclaimed host claims it implicitly", () => {
  const r = new ClaimRegistry();
  r.register("a", "desktop", fakeSocket());
  assert.equal(r.current?.clientId, "a");
  assert.equal(r.mayAttach("b"), false);
});

test("unregister drops a socket so it is not evicted later", () => {
  const r = new ClaimRegistry();
  r.claim("a", "desktop", 1000);
  const socket = fakeSocket();
  r.register("a", "desktop", socket);
  r.unregister("a", socket);
  assert.equal(r.socketCount("a"), 0);

  r.claim("b", "phone", 2000);
  assert.deepEqual(socket.reasons, [], "a closed socket must not be evicted");
});

test("unregistering an unknown socket is harmless", () => {
  const r = new ClaimRegistry();
  r.unregister("nobody", fakeSocket());
  assert.equal(r.socketCount(), 0);
});

test("socketCount totals across clients", () => {
  const r = new ClaimRegistry();
  r.register("a", "desktop", fakeSocket());
  r.register("a", "desktop", fakeSocket());
  assert.equal(r.socketCount(), 2);
  assert.equal(r.socketCount("a"), 2);
  assert.equal(r.socketCount("b"), 0);
});
