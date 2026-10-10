import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center">
      <h1 className="text-lg font-semibold">Not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">This page does not exist, or you do not have access to it.</p>
      <Link href="/" className="mt-5 inline-block text-sm text-primary hover:underline">
        Back to the dashboard
      </Link>
    </div>
  );
}
