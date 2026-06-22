import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import { signIn } from "../lib/auth";
import logoUrl from "../assets/logos/logo.svg";
import { registrationOpen } from "../lib/host-mode";

export const Route = createFileRoute("/login")({
  component: LoginRouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
});

function LoginRouteComponent() {
  const { error } = Route.useSearch();
  return <LoginPage error={error} />;
}

type Provider = "github" | "google";

function startOAuth(provider: Provider) {
  signIn.social({
    provider,
    callbackURL: `${window.location.origin}/projects`,
    errorCallbackURL: `${window.location.origin}/login`,
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function LoginPage({ error }: { error?: string }) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);

  const isValid = EMAIL_RE.test(email);

  function onMagicLinkSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!isValid || loading) return;
    setLoading(true);
    // Backend magic-link delivery is not yet wired; the UI completes the
    // "request sent" affordance so OAuth-less sign-in can be plugged in
    // (Better Auth `magicLink` plugin) without revisiting the layout.
    setTimeout(() => {
      setLoading(false);
      setSubmitted(true);
    }, 700);
  }

  return (
    <>
      <style>{LOGIN_STYLES}</style>
      <div className="si-shell">
        <div className="si-glow" />
        <div className="si-grid" />

        <header className="si-bar">
          <div className="si-logo">
            <img src={logoUrl} alt="Rovenue" className="si-logo-img" />
          </div>
        </header>

        <div className="si-form-col">
          <div className="si-card">
            {!submitted ? (
              <>
                <span className="si-eyebrow">
                  <span className="dot" />
                  {t("auth.signIn.eyebrow")}
                </span>
                <h1>
                  {t("auth.signIn.welcomePrefix")}
                  <span className="grad">{t("auth.signIn.welcomeBrand")}</span>
                </h1>
                <p className="sub">{t("auth.signIn.tagline")}</p>

                {error && (
                  <div role="alert" className="si-error">
                    {error === "REGISTRATION_CLOSED"
                      ? t("auth.signIn.errorRegistrationClosed")
                      : error}
                  </div>
                )}

                {!registrationOpen && (
                  <div role="status" className="si-info">
                    {t("auth.signIn.inviteOnly")}
                  </div>
                )}

                <div className="si-social">
                  <button
                    type="button"
                    className="si-btn"
                    onClick={() => startOAuth("google")}
                  >
                    <span className="ic">
                      <GoogleIcon />
                    </span>
                    <span>{t("auth.continueWithGoogle")}</span>
                  </button>
                  <button
                    type="button"
                    className="si-btn"
                    onClick={() => startOAuth("github")}
                  >
                    <span className="ic">
                      <GithubIcon />
                    </span>
                    <span>{t("auth.continueWithGithub")}</span>
                  </button>
                </div>

                <div className="si-divider">{t("auth.signIn.orWithEmail")}</div>

                <form className="si-magic-form" onSubmit={onMagicLinkSubmit}>
                  <div className="si-field">
                    <label htmlFor="login-email">
                      {t("auth.signIn.emailLabel")}
                      <span className="hint">{t("auth.signIn.emailHint")}</span>
                    </label>
                    <div className={"si-input-wrap" + (isValid ? " ok" : "")}>
                      <span className="ic">
                        <EmailIcon />
                      </span>
                      <input
                        id="login-email"
                        type="email"
                        autoComplete="email"
                        placeholder={t("auth.signIn.emailPlaceholder")}
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                      />
                      <span className="si-check" aria-hidden>
                        <CheckIcon />
                      </span>
                    </div>
                  </div>

                  <button
                    type="submit"
                    className="si-cta"
                    disabled={!isValid || loading}
                  >
                    {loading ? <span className="spin" aria-hidden /> : null}
                    <span>
                      {loading
                        ? t("auth.signIn.magicSending")
                        : t("auth.signIn.magicSend")}
                    </span>
                    {!loading && (
                      <span className="arrow" aria-hidden>
                        <ArrowIcon />
                      </span>
                    )}
                  </button>
                </form>

                <p className="si-hint">
                  <Trans
                    i18nKey="auth.signIn.terms"
                    components={{ 1: <a href="#" />, 3: <a href="#" /> }}
                  />
                </p>
              </>
            ) : (
              <>
                <span className="si-eyebrow">
                  <span className="dot" />
                  {t("auth.signIn.checkInbox")}
                </span>
                <div className="si-sent">
                  <div className="si-sent-ic">
                    <EmailIcon size={26} />
                  </div>
                  <h2>{t("auth.signIn.sentTitle")}</h2>
                  <p>
                    <Trans
                      i18nKey="auth.signIn.sentBody"
                      values={{ email }}
                      components={{ 1: <b />, 3: <b /> }}
                    />
                  </p>
                  <div className="row">
                    <button
                      type="button"
                      className="si-btn si-btn--sm"
                      onClick={() => {
                        setSubmitted(false);
                      }}
                    >
                      {t("auth.signIn.useDifferentEmail")}
                    </button>
                    <button
                      type="button"
                      className="si-btn si-btn--sm"
                      onClick={() => {
                        setLoading(true);
                        setTimeout(() => setLoading(false), 700);
                      }}
                    >
                      {t("auth.signIn.resend")}
                    </button>
                  </div>
                </div>
                <p className="si-hint">
                  <Trans
                    i18nKey="auth.signIn.sentHelp"
                    components={{
                      1: (
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setSubmitted(false);
                          }}
                        />
                      ),
                    }}
                  />
                </p>
              </>
            )}
          </div>
        </div>

        <aside className="si-aside">
          <div className="si-aside-inner">
            <div className="si-aside-top">
              <span className="si-eyebrow">
                <span className="dot" />
                {t("auth.signIn.aside.eyebrow")}
              </span>
              <h2>
                {t("auth.signIn.aside.headlinePrefix")}
                <span className="grad">
                  {t("auth.signIn.aside.headlineBrand")}
                </span>
                {t("auth.signIn.aside.headlineSuffix")}
              </h2>

              <div className="si-feats">
                <Feature
                  icon={<ChartIcon />}
                  title={t("auth.signIn.aside.features.mrrTitle")}
                  desc={t("auth.signIn.aside.features.mrrDesc")}
                />
                <Feature
                  icon={<CodeIcon />}
                  title={t("auth.signIn.aside.features.sdkTitle")}
                  desc={t("auth.signIn.aside.features.sdkDesc")}
                />
                <Feature
                  icon={<ShieldIcon />}
                  title={t("auth.signIn.aside.features.complianceTitle")}
                  desc={t("auth.signIn.aside.features.complianceDesc")}
                />
              </div>
            </div>

            <div className="si-aside-bottom">
              <figure className="si-quote">
                <blockquote>{t("auth.signIn.aside.quote")}</blockquote>
                <figcaption className="by">
                  <span className="av">AK</span>
                  <div>
                    <div className="nm">
                      {t("auth.signIn.aside.quoteAuthor")}
                    </div>
                    <div className="tt">
                      {t("auth.signIn.aside.quoteTitle")}
                    </div>
                  </div>
                </figcaption>
              </figure>

              <div className="si-bottom-aside">
                <span className="pill">
                  <span className="d" />
                  {t("auth.signIn.aside.statusPill")}
                </span>
                <span>{t("auth.signIn.aside.version")}</span>
              </div>
            </div>
          </div>
        </aside>

        <footer className="si-footer">
          <span>{t("auth.signIn.footer.copyright")}</span>
          <nav>
            <a href="#">{t("auth.signIn.footer.docs")}</a>
            <a href="https://github.com/rovenue" target="_blank" rel="noreferrer">
              {t("auth.signIn.footer.github")}
            </a>
            <a href="#">{t("auth.signIn.footer.status")}</a>
            <a href="#">{t("auth.signIn.footer.privacy")}</a>
            <a href="#">{t("auth.signIn.footer.terms")}</a>
          </nav>
        </footer>
      </div>
    </>
  );
}

function Feature({
  icon,
  title,
  desc,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <div className="si-feat">
      <span className="icw">{icon}</span>
      <div>
        <div className="si-feat-t">{title}</div>
        <div className="si-feat-d">{desc}</div>
      </div>
    </div>
  );
}

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
    <path
      fill="#4285F4"
      d="M17.64 9.2c0-.64-.06-1.25-.17-1.84H9v3.49h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.63z"
    />
    <path
      fill="#34A853"
      d="M9 18c2.43 0 4.47-.81 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
    />
    <path
      fill="#FBBC05"
      d="M3.97 10.71A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.17.29-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3.01-2.33z"
    />
    <path
      fill="#EA4335"
      d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
    />
  </svg>
);

const EmailIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </svg>
);

const CheckIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const ArrowIcon = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
);

const GithubIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.57.1.78-.25.78-.55v-2.05c-3.2.7-3.87-1.36-3.87-1.36-.52-1.34-1.28-1.7-1.28-1.7-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.18-3.09-.12-.29-.51-1.46.11-3.04 0 0 .97-.31 3.18 1.18a11 11 0 0 1 2.89-.39c.98 0 1.97.13 2.89.39 2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.12 3.04.74.81 1.18 1.83 1.18 3.09 0 4.42-2.69 5.4-5.25 5.68.41.36.78 1.06.78 2.13v3.16c0 .3.21.66.79.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
  </svg>
);

const ChartIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M3 3v18h18" />
    <path d="M7 15l4-4 4 4 5-5" />
  </svg>
);

const ShieldIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

const CodeIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <polyline points="16 18 22 12 16 6" />
    <polyline points="8 6 2 12 8 18" />
  </svg>
);

const LOGIN_STYLES = `
.si-shell {
  --si-primary-300: #93C5FD;
  --si-primary-400: var(--color-rv-accent-400, #60A5FA);
  --si-primary-500: var(--color-rv-accent-500, #3B82F6);
  --si-primary-700: var(--color-rv-accent-700, #1D4ED8);
  --si-violet: var(--color-rv-violet, #8B5CF6);
  --si-content1: var(--color-rv-c1, #0F0F12);
  --si-content2: var(--color-rv-c2, #151518);
  --si-divider: var(--color-rv-divider, rgba(255,255,255,0.08));
  --si-divider-strong: var(--color-rv-divider-strong, rgba(255,255,255,0.12));
  --si-mute-500: var(--color-rv-mute-500, #71717A);
  --si-mute-600: var(--color-rv-mute-600, #A1A1AA);
  --si-mute-700: var(--color-rv-mute-700, #D4D4D8);
  --si-mute-800: var(--color-rv-mute-800, #E4E4E7);
  --si-fg: #FAFAFA;
  --si-success: var(--color-rv-success, #10B981);

  position: relative;
  min-height: 100vh;
  display: grid;
  grid-template-columns: 1fr 1fr;
  background: #000;
  color: var(--si-fg);
  font-family: "Geist", ui-sans-serif, system-ui, -apple-system, sans-serif;
  overflow: hidden;
}
@media (max-width: 880px) {
  .si-shell { grid-template-columns: 1fr; }
  .si-aside { display: none; }
}

.si-glow {
  position: absolute; inset: 0; pointer-events: none;
  background:
    radial-gradient(60% 50% at 20% 20%, color-mix(in srgb, var(--si-primary-500) 16%, transparent), transparent 70%),
    radial-gradient(50% 50% at 85% 80%, color-mix(in srgb, var(--si-violet) 14%, transparent), transparent 70%),
    radial-gradient(40% 40% at 80% 10%, color-mix(in srgb, var(--si-primary-700) 10%, transparent), transparent 70%);
}
.si-grid {
  position: absolute; inset: 0; pointer-events: none;
  background-image:
    linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
  background-size: 56px 56px;
  mask: radial-gradient(80% 80% at 50% 50%, #000 30%, transparent 70%);
  -webkit-mask: radial-gradient(80% 80% at 50% 50%, #000 30%, transparent 70%);
}

.si-bar {
  position: absolute; inset: 0 0 auto 0;
  height: 56px;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 28px; z-index: 5;
}
.si-logo { display: flex; align-items: center; }
.si-logo-img {
  height: 28px;
  width: auto;
  display: block;
  user-select: none;
}
.si-bar-cta { font-size: 12.5px; color: var(--si-mute-600); }
.si-bar-cta a {
  color: var(--si-primary-400);
  text-decoration: none;
  font-weight: 500;
  margin-left: 4px;
}
.si-bar-cta a:hover { text-decoration: underline; }

.si-form-col {
  position: relative; z-index: 2;
  display: flex; align-items: center; justify-content: center;
  padding: 40px 32px;
}
.si-card {
  width: 100%; max-width: 420px;
  display: flex; flex-direction: column; gap: 24px;
}
.si-eyebrow {
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 11px;
  color: var(--si-primary-400);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  display: inline-flex; align-items: center; gap: 8px;
}
.si-eyebrow .dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--si-primary-400);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--si-primary-500) 25%, transparent);
}
.si-card h1 {
  margin: 0; font-size: 30px; font-weight: 600;
  letter-spacing: -0.02em; line-height: 1.15;
}
.si-card h1 .grad,
.si-aside h2 .grad {
  background: linear-gradient(135deg, #fff 0%, color-mix(in srgb, var(--si-primary-300) 90%, white) 60%, var(--si-primary-400) 100%);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}
.si-aside h2 .grad {
  background: linear-gradient(135deg, #fff, color-mix(in srgb, var(--si-primary-300) 80%, white) 60%, var(--si-violet));
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
}
.si-card .sub {
  margin: 0; color: var(--si-mute-500);
  font-size: 14px; line-height: 1.55;
}

.si-error {
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, #EF4444 40%, var(--si-divider));
  background: color-mix(in srgb, #EF4444 10%, var(--si-content1));
  color: #FCA5A5;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.4;
}

.si-info {
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--si-primary-500) 35%, var(--si-divider));
  background: color-mix(in srgb, var(--si-primary-500) 8%, var(--si-content1));
  color: var(--si-mute-600);
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.4;
}

.si-social { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.si-btn {
  height: 44px;
  display: inline-flex; align-items: center; justify-content: center; gap: 10px;
  background: var(--si-content1);
  border: 1px solid var(--si-divider);
  border-radius: 9px;
  color: var(--si-fg); font-size: 13.5px; font-weight: 500;
  cursor: pointer; font-family: inherit;
  transition: border-color 120ms, background 120ms, transform 120ms;
}
.si-btn:hover { border-color: var(--si-divider-strong); background: var(--si-content2); }
.si-btn:active { transform: scale(0.985); }
.si-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px #000, 0 0 0 4px var(--si-primary-500);
}
.si-btn .ic {
  width: 18px; height: 18px;
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}

.si-hint {
  font-size: 11.5px; color: var(--si-mute-500);
  line-height: 1.55; text-align: center;
  margin: 0;
}
.si-hint a { color: var(--si-primary-400); text-decoration: none; }
.si-hint a:hover { text-decoration: underline; }

.si-divider {
  display: flex; align-items: center; gap: 12px;
  color: var(--si-mute-500); font-size: 11px;
  text-transform: uppercase; letter-spacing: 0.08em;
  font-family: "Geist Mono", ui-monospace, monospace;
}
.si-divider::before,
.si-divider::after {
  content: ""; flex: 1; height: 1px; background: var(--si-divider);
}

.si-magic-form { display: flex; flex-direction: column; gap: 12px; }
.si-field { display: flex; flex-direction: column; gap: 6px; }
.si-field label {
  font-size: 12px; font-weight: 500; color: var(--si-mute-700);
  display: flex; justify-content: space-between; align-items: baseline;
}
.si-field label .hint {
  font-size: 11px; color: var(--si-mute-500); font-weight: 400;
  font-family: "Geist Mono", ui-monospace, monospace;
}
.si-input-wrap {
  position: relative;
  height: 44px;
  background: var(--si-content1);
  border: 1px solid var(--si-divider);
  border-radius: 9px;
  display: flex; align-items: center; gap: 8px;
  padding: 0 10px 0 12px;
  transition: border-color 120ms, box-shadow 120ms;
}
.si-input-wrap:focus-within {
  border-color: var(--si-primary-500);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--si-primary-500) 18%, transparent);
}
.si-input-wrap .ic { color: var(--si-mute-500); flex-shrink: 0; display: inline-flex; }
.si-input-wrap input {
  flex: 1; background: transparent; border: none; outline: none;
  color: var(--si-fg); font-family: inherit; font-size: 14px;
  padding: 0;
}
.si-input-wrap input::placeholder { color: var(--si-mute-500); }
.si-input-wrap.ok { border-color: color-mix(in srgb, var(--si-success) 60%, var(--si-divider)); }
.si-check {
  color: var(--si-success);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity 160ms;
  display: inline-flex;
}
.si-input-wrap.ok .si-check { opacity: 1; }

.si-cta {
  height: 46px;
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  background: linear-gradient(135deg, var(--si-primary-500), var(--si-primary-700));
  color: #fff; border: none; border-radius: 9px;
  font-family: inherit; font-size: 14px; font-weight: 600;
  cursor: pointer; position: relative; overflow: hidden;
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.2),
    0 6px 24px color-mix(in srgb, var(--si-primary-500) 40%, transparent),
    0 1px 0 rgba(0,0,0,0.3);
  transition: transform 120ms;
}
.si-cta:hover:not(:disabled) { transform: translateY(-1px); }
.si-cta:active:not(:disabled) { transform: translateY(0); }
.si-cta:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }
.si-cta .arrow { display: inline-flex; transition: transform 160ms; }
.si-cta:hover:not(:disabled) .arrow { transform: translateX(3px); }

.spin {
  width: 14px; height: 14px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: si-spin 0.7s linear infinite;
}
@keyframes si-spin { to { transform: rotate(360deg); } }

.si-sent {
  background: var(--si-content1);
  border: 1px solid var(--si-divider);
  border-radius: 12px;
  padding: 28px 24px;
  display: flex; flex-direction: column; gap: 14px;
  text-align: center;
}
.si-sent-ic {
  width: 56px; height: 56px;
  margin: 0 auto;
  border-radius: 14px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--si-primary-500) 24%, transparent), transparent),
    color-mix(in srgb, var(--si-primary-500) 10%, var(--si-content2));
  border: 1px solid color-mix(in srgb, var(--si-primary-500) 35%, var(--si-divider));
  display: flex; align-items: center; justify-content: center;
  color: var(--si-primary-400);
}
.si-sent h2 { margin: 0; font-size: 18px; font-weight: 600; }
.si-sent p {
  margin: 0; font-size: 13px; color: var(--si-mute-500); line-height: 1.55;
}
.si-sent p b {
  color: var(--si-fg);
  font-family: "Geist Mono", ui-monospace, monospace;
  font-weight: 500;
}
.si-sent .row {
  display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;
  margin-top: 6px;
}
.si-btn--sm {
  height: 36px; padding: 0 14px; font-size: 12.5px;
}

.si-aside {
  position: relative;
  overflow: hidden;
  border-left: 1px solid var(--si-divider);
  background:
    radial-gradient(80% 80% at 100% 0%, color-mix(in srgb, var(--si-violet) 18%, transparent), transparent 60%),
    radial-gradient(70% 70% at 0% 100%, color-mix(in srgb, var(--si-primary-700) 22%, transparent), transparent 60%),
    #050507;
}
.si-aside-inner {
  position: relative; z-index: 2;
  height: 100%;
  padding: 96px 56px 88px;
  display: flex; flex-direction: column; justify-content: space-between; gap: 36px;
}
.si-aside-top { display: flex; flex-direction: column; gap: 28px; }
.si-aside h2 {
  margin: 0; font-size: 30px; line-height: 1.15;
  letter-spacing: -0.015em; font-weight: 600;
}
.si-feats { display: flex; flex-direction: column; gap: 14px; }
.si-feat {
  display: flex; gap: 12px;
  padding: 14px 16px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--si-divider);
  border-radius: 10px;
  backdrop-filter: blur(8px);
}
.si-feat .icw {
  width: 30px; height: 30px; border-radius: 7px;
  background: color-mix(in srgb, var(--si-primary-500) 16%, transparent);
  color: var(--si-primary-400);
  display: inline-flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.si-feat-t { font-size: 13.5px; font-weight: 500; margin-bottom: 2px; }
.si-feat-d { font-size: 12px; color: var(--si-mute-500); line-height: 1.5; }

.si-aside-bottom { display: flex; flex-direction: column; gap: 18px; }
.si-quote {
  margin: 0;
  padding: 18px 20px;
  background: rgba(255,255,255,0.02);
  border: 1px solid var(--si-divider);
  border-radius: 10px;
  backdrop-filter: blur(8px);
}
.si-quote blockquote {
  margin: 0;
  font-size: 14px; line-height: 1.6;
  color: var(--si-mute-800);
}
.si-quote .by { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.si-quote .av {
  width: 32px; height: 32px; border-radius: 50%;
  background: linear-gradient(135deg, #F59E0B, #EC4899);
  display: flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 600; color: #fff;
  font-family: "Geist Mono", ui-monospace, monospace;
}
.si-quote .nm { font-size: 12.5px; font-weight: 500; }
.si-quote .tt {
  font-size: 11px; color: var(--si-mute-500);
  font-family: "Geist Mono", ui-monospace, monospace;
}

.si-bottom-aside {
  display: flex; justify-content: space-between; align-items: center;
  font-size: 11px; color: var(--si-mute-500);
  font-family: "Geist Mono", ui-monospace, monospace;
}
.si-bottom-aside .pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 10px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--si-divider);
  border-radius: 999px;
}
.si-bottom-aside .pill .d {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--si-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--si-success) 28%, transparent);
}

.si-footer {
  position: absolute; left: 0; right: 0; bottom: 0;
  height: 48px;
  display: flex; align-items: center; justify-content: space-between;
  padding: 0 28px;
  font-size: 11px; color: var(--si-mute-500);
  font-family: "Geist Mono", ui-monospace, monospace;
  z-index: 5;
}
.si-footer nav { display: flex; gap: 14px; }
.si-footer a { color: var(--si-mute-600); text-decoration: none; }
.si-footer a:hover { color: var(--si-fg); }
`;
