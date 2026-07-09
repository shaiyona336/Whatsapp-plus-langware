"use client";

import { useEffect, useState } from "react";

import { ChatApp } from "@/components/ChatApp";
import { Login } from "@/components/Login";

const STORAGE_KEY = "termchat.me";

export default function Home() {
  const [me, setMe] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Restore the session (username) on load. sessionStorage is per-tab, so two
  // tabs can stay logged in as different users across refreshes.
  useEffect(() => {
    setMe(sessionStorage.getItem(STORAGE_KEY));
    setReady(true);
  }, []);

  function login(username: string) {
    sessionStorage.setItem(STORAGE_KEY, username);
    setMe(username);
  }

  function logout() {
    sessionStorage.removeItem(STORAGE_KEY);
    setMe(null);
  }

  if (!ready) return null; // avoid a login/app flash before we read storage

  return me ? (
    <ChatApp me={me} onLogout={logout} />
  ) : (
    <Login onLogin={login} />
  );
}
