import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export default function NotFound() {
  return (
    <main id="main-content" tabIndex={-1} className="min-h-[60vh] w-full flex items-center justify-center bg-background py-12">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2">
            <AlertCircle className="h-8 w-8 shrink-0 text-warning" aria-hidden="true" />
            <h1 className="text-2xl font-semibold text-foreground">Page unavailable</h1>
          </div>

          <p className="mt-4 text-base text-muted-foreground">
            This address does not have an IMMUNE workspace. Return to the observer to inspect available evidence.
          </p>
          <a className="kanchay-action mt-6" href={import.meta.env.BASE_URL}>Open the workspace</a>
        </CardContent>
      </Card>
    </main>
  );
}
