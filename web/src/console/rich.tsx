/**
 * A text Claude wrote, its `**key words**` in bold (Kevin 2026-11-23: « add bold wherever necessary to make the reading
 * faster »). Pure: renders in server and client components alike. `plain` drops the marks where bold cannot show
 * (a title attribute, a sentence cut).
 */
export function Rich({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return (
    <>
      {text.split(/(\*\*[^*]+\*\*)/g).map((p, i) =>
        p.length > 4 && p.startsWith("**") && p.endsWith("**") ? (
          <strong key={i} className="font-semibold text-kumo-strong">
            {p.slice(2, -2)}
          </strong>
        ) : (
          // A mark left alone (a text cut mid-bold) never shows.
          p.replace(/\*\*/g, "")
        ),
      )}
    </>
  );
}

export const plain = (text: string): string => text.replace(/\*\*/g, "");
