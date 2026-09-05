import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Globe, Plus, X } from "lucide-react";
import { parseAllowedOrigin } from "@rovenue/shared";
import { Button } from "../../ui/button";

interface Props {
  origins: ReadonlyArray<string>;
  disabled?: boolean;
  onChange: (origins: string[]) => Promise<void> | void;
}

/**
 * Editor for one key's browser origin allow-list.
 *
 * Validation uses `parseAllowedOrigin` from @rovenue/shared — the same
 * function the API applies before persisting. The form is the convenient
 * place to catch a typo, not the place the rule lives: a script calling the
 * endpoint directly gets the identical refusal.
 *
 * The empty state says what empty MEANS rather than that the list is empty.
 * A key with no origins is not "unconfigured", it is unusable from a browser,
 * and the failure a developer then sees is an opaque CORS error with no
 * mention of Rovenue in it.
 */
export function AllowedOriginsEditor({ origins, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function commit(next: string[]) {
    setBusy(true);
    try {
      await onChange(next);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t(
              "sdkApi.keys.origins.saveFailed",
              "Couldn't save the origin list. Please try again.",
            ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const parsed = parseAllowedOrigin(draft);
    if (parsed === null) {
      setError(
        t(
          "sdkApi.keys.origins.invalid",
          "Enter a scheme and host, like https://app.example.com. No wildcards, no path.",
        ),
      );
      return;
    }
    if (origins.includes(parsed)) {
      setDraft("");
      return;
    }
    setDraft("");
    await commit([...origins, parsed]);
  }

  return (
    <div className="mt-2 rounded-md border border-rv-divider bg-rv-c2 px-3 py-3">
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-foreground">
        <Globe size={12} />
        {t("sdkApi.keys.origins.title", "Browser origins")}
      </div>

      {origins.length === 0 ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-rv-mute-500">
          {t(
            "sdkApi.keys.origins.empty",
            "No origins yet — this key cannot be used from a web page. Add the origin your app is served from before using the Web SDK.",
          )}
        </p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {origins.map((origin) => (
            <li
              key={origin}
              className="flex items-center gap-1 rounded border border-rv-divider bg-rv-c1 px-2 py-1 text-[12px] text-foreground"
            >
              <code>{origin}</code>
              <button
                type="button"
                disabled={disabled || busy}
                aria-label={t("sdkApi.keys.origins.remove", "Remove {{origin}}", {
                  origin,
                })}
                className="text-rv-mute-500 hover:text-rv-danger disabled:opacity-50"
                onClick={() =>
                  commit(origins.filter((o) => o !== origin))
                }
              >
                <X size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex gap-1.5">
        <input
          type="text"
          value={draft}
          disabled={disabled || busy}
          placeholder="https://app.example.com"
          aria-label={t("sdkApi.keys.origins.add", "Add a browser origin")}
          className="min-w-0 flex-1 rounded border border-rv-divider bg-rv-c1 px-2 py-1 text-[12px] text-foreground placeholder:text-rv-mute-500 disabled:opacity-50"
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void add();
            }
          }}
        />
        <Button
          variant="light"
          size="sm"
          disabled={disabled || busy || draft.trim() === ""}
          onClick={() => void add()}
        >
          <Plus size={12} />
          {t("sdkApi.keys.origins.addAction", "Add")}
        </Button>
      </div>

      {error !== null && (
        <p role="alert" className="mt-1.5 text-[12px] text-rv-danger">
          {error}
        </p>
      )}
    </div>
  );
}
