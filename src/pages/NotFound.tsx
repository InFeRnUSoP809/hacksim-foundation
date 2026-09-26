import { Button } from "@/components/ui/button";
import { Wordmark } from "@/components/Wordmark";
import { Link } from "react-router";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center px-5 sm:px-8">
          <Link to="/">
            <Wordmark />
          </Link>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-5 py-20">
        <div className="w-full max-w-md text-center">
          <p className="label-mono text-muted-foreground">Error 404</p>
          <h1 className="mt-4 text-3xl font-semibold tracking-[-0.03em]">
            Route not found
          </h1>
          <p className="mt-3 text-base leading-relaxed text-muted-foreground">
            That page doesn&rsquo;t exist in this build.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button asChild>
              <Link to="/">Back to home</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/dashboard">Go to dashboard</Link>
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
