import { Link } from "@tanstack/react-router";

export function RoviMissingConfig({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <p className="text-sm font-medium text-foreground">Rovi needs an API key</p>
      <p className="mt-1 max-w-[280px] text-xs text-rv-mute-600">
        Add a provider API key (OpenAI, Anthropic, Mistral, or local Ollama) to use
        Rovi in this project.
      </p>
      <Link
        to={"/projects/$projectId/settings/rovi" as never}
        params={{ projectId } as never}
        className="mt-4 inline-flex h-8 items-center rounded-md bg-rv-c4 px-3 text-xs font-medium text-foreground transition hover:opacity-90"
      >
        Add API key
      </Link>
    </div>
  );
}
