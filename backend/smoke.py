"""API smoke test: exercise the hero path with no UI and no agent.
Alice shares a terminal; Bob runs a command. Since no agent process is
connected inside this test, the relay's graceful degradation answers —
the transcript still gets a terminal_output row explaining the situation.
"""
import os, tempfile
os.environ["DB_PATH"] = os.path.join(tempfile.gettempdir(), "smoke.db")
if os.path.exists(os.environ["DB_PATH"]):
    os.remove(os.environ["DB_PATH"])

from fastapi.testclient import TestClient
import main

c = TestClient(main.app)

with c:  # triggers startup (init_db + workspace)
    assert c.post("/login", json={"username": "alice"}).status_code == 200
    assert c.post("/login", json={"username": "bob"}).status_code == 200
    assert {u["username"] for u in c.get("/users").json()} == {"alice", "bob"}

    conv = c.post("/conversations", json={"me": "bob", "other": "alice"}).json()
    print("conversation:", conv)

    # chat frame works
    c.post("/messages", json={"conversation_id": conv["id"], "sender": "alice", "body": "hi bob"})

    # HERO: alice shares a terminal rooted at the backend dir
    root = os.path.dirname(__file__)
    term = c.post("/terminals/share", json={
        "conversation_id": conv["id"], "shared_by": "alice", "root_folder": root}).json()
    print("terminal:", term)
    assert term["status"] == "active"

    # HERO: bob (the guest) runs a command in alice's shared terminal. No
    # agent is connected here, so the relay must degrade gracefully: the
    # command still gets a transcript entry whose output says why.
    cmd = "dir" if os.name == "nt" else "ls"
    out = c.post("/terminals/run", json={
        "terminal_id": term["id"], "sender": "bob", "command": cmd}).json()
    print("output kind:", out["kind"])
    print("---- OUTPUT ----")
    print(out["body"][:400])
    assert out["kind"] == "terminal_output"
    assert "no agent connected" in out["body"], "expected graceful no-agent reply"

    # revoke: only owner
    denied = c.post("/terminals/revoke", json={"terminal_id": term["id"], "requested_by": "bob"})
    assert denied.status_code == 403, "bob must NOT be able to revoke"
    ok = c.post("/terminals/revoke", json={"terminal_id": term["id"], "requested_by": "alice"})
    assert ok.status_code == 200

    # closed terminal refuses commands
    after = c.post("/terminals/run", json={
        "terminal_id": term["id"], "sender": "bob", "command": cmd})
    assert after.status_code == 409, "closed terminal must reject"

print("\nSMOKE PASSED - hero path works end-to-end")
