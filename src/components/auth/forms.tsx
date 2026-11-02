"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { inputCls, labelCls } from "@/components/ui";
import { useSession } from "@/components/auth/session-provider";
import { AuthShell, FormError, FormNotice, GoogleButton } from "@/components/auth/auth-shell";
import { Turnstile } from "@/components/auth/turnstile";
import type { SessionPayload } from "@/lib/session-types";

const MIN_PASSWORD = 10;

async function postJson<T>(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T & { error?: string; message?: string; code?: string } }> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; message?: string; code?: string };
  return { ok: response.ok, status: response.status, data };
}

/**
 * A rejected or expired Turnstile token must not be retried: the widget is
 * re-rendered so the next submit carries a fresh single-use token.
 */
function isTurnstileError(code?: string): boolean {
  return Boolean(code && code.startsWith("turnstile"));
}

const OAUTH_ERRORS: Record<string, string> = {
  google_unavailable: "Google sign-in is not configured on this deployment.",
  google_failed: "Google sign-in could not be completed. Please try again.",
  google_cancelled: "Google sign-in was cancelled.",
  oauth_state_missing: "Your sign-in session expired. Please try again.",
  oauth_state_invalid: "Your sign-in session could not be verified. Please try again.",
  oauth_state_mismatch: "Your sign-in session could not be verified. Please try again.",
  oauth_state_expired: "Your sign-in session expired. Please try again.",
};

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

export function LoginForm({
  googleEnabled,
  next,
  oauthError,
  turnstileSiteKey = "",
}: {
  googleEnabled: boolean;
  next: string;
  oauthError?: string;
  turnstileSiteKey?: string;
}) {
  const router = useRouter();
  const { setSession } = useSession();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(oauthError ? (OAUTH_ERRORS[oauthError] ?? "Sign-in failed.") : null);
  const [busy, setBusy] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaEpoch, setCaptchaEpoch] = useState(0);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { ok, data } = await postJson<SessionPayload>("/api/auth/login", {
        email,
        password,
        turnstileToken: captcha ?? undefined,
      });
      if (!ok) {
        setError(data.error ?? "Could not sign you in.");
        if (isTurnstileError(data.code)) setCaptchaEpoch((value) => value + 1);
        return;
      }
      setSession(data);
      router.push(next);
      router.refresh();
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Sign in"
      subtitle="Use the email address you registered with."
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-slate-600 dark:text-slate-400">
            New here?{" "}
            <Link href="/register" className="font-semibold text-blue-700 hover:underline dark:text-blue-300">
              Create an account
            </Link>
          </span>
          <Link href="/forgot-password" className="font-semibold text-slate-600 hover:underline dark:text-slate-300">
            Forgot password?
          </Link>
        </div>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <div>
          <label className={labelCls} htmlFor="login-email">Email address</label>
          <input
            id="login-email"
            className={inputCls}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="login-password">Password</label>
          <input
            id="login-password"
            className={inputCls}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <Turnstile siteKey={turnstileSiteKey} onToken={setCaptcha} resetKey={captchaEpoch} />
        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
        >
          {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
          Sign in
        </button>
      </form>
      <div className="my-5 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" /> or <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
      </div>
      <GoogleButton enabled={googleEnabled} next={next} />
    </AuthShell>
  );
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

export function RegisterForm({ googleEnabled, turnstileSiteKey = "" }: { googleEnabled: boolean; turnstileSiteKey?: string }) {
  const router = useRouter();
  const { setSession } = useSession();
  const [form, setForm] = useState({ displayName: "", email: "", password: "", confirm: "", marketing: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaEpoch, setCaptchaEpoch] = useState(0);

  const update = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (form.password !== form.confirm) {
      setError("The two passwords do not match.");
      return;
    }
    if (form.password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters with at least one letter and one number.`);
      return;
    }
    setBusy(true);
    try {
      const { ok, data } = await postJson<SessionPayload & { previewUrl?: string; verificationSent?: boolean }>("/api/auth/register", {
        email: form.email,
        password: form.password,
        displayName: form.displayName,
        marketingOptIn: form.marketing,
        turnstileToken: captcha ?? undefined,
      });
      if (!ok) {
        setError(data.error ?? "Could not create your account.");
        if (isTurnstileError(data.code)) setCaptchaEpoch((value) => value + 1);
        return;
      }
      setSession(data);
      const query = new URLSearchParams({ welcome: "1" });
      if (data.previewUrl) query.set("preview", data.previewUrl);
      router.push(`/dashboard?${query.toString()}`);
      router.refresh();
    } catch {
      setError("Network error. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Create your account"
      subtitle="Free forever with private cloud storage."
      footer={
        <span className="text-slate-600 dark:text-slate-400">
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-blue-700 hover:underline dark:text-blue-300">
            Sign in
          </Link>
        </span>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        <div>
          <label className={labelCls} htmlFor="register-name">Name <span className="font-normal text-slate-400">(optional)</span></label>
          <input
            id="register-name"
            className={inputCls}
            autoComplete="name"
            maxLength={80}
            value={form.displayName}
            onChange={(event) => update({ displayName: event.target.value })}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="register-email">Email address</label>
          <input
            id="register-email"
            className={inputCls}
            type="email"
            autoComplete="email"
            required
            value={form.email}
            onChange={(event) => update({ email: event.target.value })}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className={labelCls} htmlFor="register-password">Password</label>
            <input
              id="register-password"
              className={inputCls}
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              value={form.password}
              onChange={(event) => update({ password: event.target.value })}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="register-confirm">Confirm password</label>
            <input
              id="register-confirm"
              className={inputCls}
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              value={form.confirm}
              onChange={(event) => update({ confirm: event.target.value })}
            />
          </div>
        </div>
        <p className="text-[11px] text-slate-500 dark:text-slate-400">
          At least {MIN_PASSWORD} characters, with a letter and a number. We send a verification email after sign-up.
        </p>
        <label className="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.marketing}
            onChange={(event) => update({ marketing: event.target.checked })}
          />
          <span>Send me occasional product updates. You can turn this off at any time.</span>
        </label>
        <Turnstile siteKey={turnstileSiteKey} onToken={setCaptcha} resetKey={captchaEpoch} />
        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
        >
          {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
          Create free account
        </button>
      </form>
      <div className="my-5 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" /> or <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
      </div>
      <GoogleButton enabled={googleEnabled} next="/dashboard" />
    </AuthShell>
  );
}

/* ------------------------------------------------------------------ */
/* Forgot password                                                     */
/* ------------------------------------------------------------------ */

export function ForgotPasswordForm({ turnstileSiteKey = "" }: { turnstileSiteKey?: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaEpoch, setCaptchaEpoch] = useState(0);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { ok, data } = await postJson<{ message?: string; previewUrl?: string }>("/api/auth/forgot-password", {
        email,
        turnstileToken: captcha ?? undefined,
      });
      if (!ok) {
        setError(data.error ?? "Could not send the reset email.");
        if (isTurnstileError(data.code)) setCaptchaEpoch((value) => value + 1);
        return;
      }
      setMessage(data.message ?? "Check your inbox for the reset link.");
      setPreview(data.previewUrl ?? null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell
      title="Forgot your password?"
      subtitle="We will email you a single-use link to choose a new one."
      footer={
        <Link href="/login" className="font-semibold text-blue-700 hover:underline dark:text-blue-300">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        <FormError message={error} />
        {message && <FormNotice tone="success">{message}</FormNotice>}
        {preview && (
          <FormNotice tone="warn">
            Development mail transport: <a className="break-all font-semibold underline" href={preview}>{preview}</a>
          </FormNotice>
        )}
        <div>
          <label className={labelCls} htmlFor="forgot-email">Email address</label>
          <input
            id="forgot-email"
            className={inputCls}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Turnstile siteKey={turnstileSiteKey} onToken={setCaptcha} resetKey={captchaEpoch} />
        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
        >
          {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
          Send reset link
        </button>
      </form>
    </AuthShell>
  );
}

/* ------------------------------------------------------------------ */
/* Reset password                                                      */
/* ------------------------------------------------------------------ */

export function ResetPasswordForm({
  token,
  valid,
  turnstileSiteKey = "",
}: {
  token: string;
  valid: boolean;
  turnstileSiteKey?: string;
}) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [captchaEpoch, setCaptchaEpoch] = useState(0);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const { ok, data } = await postJson<{ message?: string }>("/api/auth/reset-password", {
        token,
        password,
        turnstileToken: captcha ?? undefined,
      });
      if (!ok) {
        setError(data.error ?? "Could not reset the password.");
        if (isTurnstileError(data.code)) setCaptchaEpoch((value) => value + 1);
        return;
      }
      setDone(true);
      setTimeout(() => router.push("/login?reset=1"), 1600);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Choose a new password" subtitle="All other devices will be signed out.">
      {!valid ? (
        <div className="space-y-4">
          <FormError message="This reset link is missing or invalid." />
          <Link href="/forgot-password" className="block rounded-lg bg-blue-600 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-blue-500">
            Request a new link
          </Link>
        </div>
      ) : done ? (
        <FormNotice tone="success">Password updated. Redirecting you to sign in…</FormNotice>
      ) : (
        <form onSubmit={submit} className="space-y-4" noValidate>
          <FormError message={error} />
          <div>
            <label className={labelCls} htmlFor="reset-password">New password</label>
            <input
              id="reset-password"
              className={inputCls}
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="reset-confirm">Confirm new password</label>
            <input
              id="reset-confirm"
              className={inputCls}
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD}
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </div>
          <Turnstile siteKey={turnstileSiteKey} onToken={setCaptcha} resetKey={captchaEpoch} />
          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60"
          >
            {busy && <Loader2 size={15} className="animate-spin" aria-hidden />}
            Update password
          </button>
        </form>
      )}
    </AuthShell>
  );
}

/* ------------------------------------------------------------------ */
/* Verify email                                                        */
/* ------------------------------------------------------------------ */

export function VerifyEmailPanel({ token }: { token: string | null }) {
  const { refresh } = useSession();
  const [state, setState] = useState<"idle" | "working" | "verified" | "error" | "missing">(token ? "working" : "missing");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let active = true;
    void (async () => {
      const { ok, data } = await postJson<{ email?: string; alreadyVerified?: boolean }>("/api/auth/verify-email", { token });
      if (!active) return;
      if (ok) {
        setState("verified");
        setMessage(
          data.alreadyVerified
            ? `${data.email ?? "Your email"} was already verified.`
            : `${data.email ?? "Your email"} is verified. Cloud uploads and checkout are unlocked.`,
        );
        await refresh();
      } else {
        setState("error");
        setMessage(data.error ?? "This verification link is not valid.");
      }
    })();
    return () => {
      active = false;
    };
  }, [token, refresh]);

  return (
    <AuthShell title="Verify your email" subtitle="Confirmation links work once and expire automatically.">
      {state === "working" || state === "idle" ? (
        <FormNotice>Verifying your link…</FormNotice>
      ) : state === "verified" ? (
        <div className="space-y-4">
          <FormNotice tone="success">{message}</FormNotice>
          <Link href="/dashboard" className="block rounded-lg bg-blue-600 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-blue-500">
            Go to my dashboard
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <FormError
            message={
              state === "missing"
                ? "This page needs a verification link. Open the link from your email, or request a new one from your dashboard."
                : message
            }
          />
          <Link href="/dashboard" className="block rounded-lg border border-slate-300 px-3 py-2 text-center text-sm font-semibold text-slate-800 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-100">
            Resend from the dashboard
          </Link>
        </div>
      )}
    </AuthShell>
  );
}
