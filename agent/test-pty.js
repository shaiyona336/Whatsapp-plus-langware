"use strict";

// Isolation test: prove PtyManager (class scope, node-pty) runs two concurrent,
// independent shells that persist state — the exact thing pywinpty failed at.
const { PtyManager } = require("./pty-manager");

const bufs = new Map();
const mgr = new PtyManager(
  (id, data) => bufs.set(id, (bufs.get(id) || "") + data),
  (id, code) => console.log(`[exit] terminal ${id} code=${code}`),
);

mgr.spawn(1, "C:\\Windows");
mgr.spawn(2, "C:\\Users");

setTimeout(() => {
  mgr.write(1, "echo T1=%CD%\r");
  mgr.write(2, "echo T2=%CD%\r");
}, 800);

setTimeout(() => {
  const o1 = bufs.get(1) || "";
  const o2 = bufs.get(2) || "";
  console.log("terminal 1 in its own cwd (C:\\Windows):", o1.includes("T1=C:\\Windows"));
  console.log("terminal 2 in its own cwd (C:\\Users):  ", o2.includes("T2=C:\\Users"));
  console.log("no cross-talk:", !o1.includes("T2=") && !o2.includes("T1="));
  process.exit(0);
}, 2200);
