import { Button } from "@heroui/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { signOut, useSession } from "../../lib/auth";
import { ThemeToggle } from "./ThemeToggle";

export function TopNav() {
  const { data } = useSession();
  const navigate = useNavigate();
  return (
    <header className="border-b border-default-200 bg-content1">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Link to="/projects" className="text-lg font-semibold">
          Rovenue
        </Link>
        <div className="flex items-center gap-3">
          <ThemeToggle />
          <span className="text-sm text-default-500">{data?.user.email}</span>
          <Button
            size="sm"
            variant="ghost"
            onPress={async () => {
              await signOut();
              await navigate({ to: "/login", search: { error: undefined } });
            }}
          >
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
