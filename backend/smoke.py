"""Block-2 smoke test: prove the hero path with no UI.
Alice shares a terminal; Bob runs a command; output comes back.
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

    # HERO: bob (the guest) runs a command in alice's shared terminal
    cmd = "dir" if os.name == "nt" else "ls"
    out = c.post("/terminals/run", json={
        "terminal_id": term["id"], "sender": "bob", "command": cmd}).json()
    print("output kind:", out["kind"])
    print("---- OUTPUT ----")
    print(out["body"][:400])
    assert "main.py" in out["body"], "expected main.py in listing"

    # revoke: only owner
    denied = c.post("/terminals/revoke", json={"terminal_id": term["id"], "requested_by": "bob"})
    assert denied.status_code == 403, "bob must NOT be able to revoke"
    ok = c.post("/terminals/revoke", json={"terminal_id": term["id"], "requested_by": "alice"})
    assert ok.status_code == 200

    # closed terminal refuses commands
    after = c.post("/terminals/run", json={
        "terminal_id": term["id"], "sender": "bob", "command": cmd})
    assert after.status_code == 409, "closed terminal must reject"

print("\nSMOKE PASSED ✅  hero path works end-to-end")
