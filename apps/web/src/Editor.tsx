export function Editor({ text, onChange }: { text: string; onChange: (t: string) => void }) {
  return (
    <textarea
      className="editor"
      value={text}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      placeholder="# Title&#10;&#10;- [ ] A task 📅 2026-01-01"
    />
  );
}
