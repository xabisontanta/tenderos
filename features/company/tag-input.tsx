"use client";

import { useId, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * A list field made of chips: type an entry and press Enter, comma or Add, or pick a
 * suggestion; remove an entry with its button or Backspace in the empty box. Free text is
 * always allowed (suggestions only help). Each chip posts as its own `name` value, which
 * features/company/schema.ts reads the same as one comma separated value.
 *
 * Leaving the box with text in it adds that text, so a typed entry is not lost when the
 * person goes straight to the next control.
 */
export function TagInput({
  id,
  name = id,
  label,
  hint,
  error,
  defaultValue = [],
  suggestions = [],
  minLength = 2,
  maxLength,
  max,
  disabled,
}: {
  id: string;
  name?: string;
  label: string;
  hint?: string;
  error?: string;
  defaultValue?: string[];
  suggestions?: string[];
  minLength?: number;
  maxLength: number;
  max: number;
  disabled?: boolean;
}) {
  const [tags, setTags] = useState<string[]>(defaultValue);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const listId = useId();
  const describedBy = [error ? `${id}-error` : null, hint ? `${id}-hint` : null, `${id}-status`].filter(Boolean).join(" ");

  function add(raw: string) {
    // A pasted list ("a, b, c") becomes several entries.
    let next = tags;
    let skipped = "";
    for (const part of raw.split(/[,\n]/)) {
      const entry = part.trim();
      if (!entry) continue;
      if (entry.length < minLength || entry.length > maxLength) skipped = `"${entry}" was not added: use ${minLength} to ${maxLength} characters.`;
      else if (next.some((t) => t.toLowerCase() === entry.toLowerCase())) skipped = `"${entry}" is already in the list.`;
      else if (next.length >= max) skipped = `The list is full (${max}).`;
      else next = [...next, entry];
    }
    if (next !== tags) {
      setTags(next);
      setNotice(`Added ${next[next.length - 1]}. ${next.length} in the list.`);
    } else if (skipped) setNotice(skipped);
    if (!skipped) setText("");
  }

  function remove(tag: string) {
    setTags(tags.filter((t) => t !== tag));
    setNotice(`Removed ${tag}.`);
  }

  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {tags.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${label}, chosen`}>
          {tags.map((tag) => (
            <li key={tag} className="flex items-center gap-1 rounded-full border bg-card px-2.5 py-1 text-xs">
              <span>{tag}</span>
              <button
                type="button"
                onClick={() => remove(tag)}
                disabled={disabled}
                aria-label={`Remove ${tag}`}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                <X className="size-3" aria-hidden />
              </button>
              <input type="hidden" name={name} value={tag} disabled={disabled} />
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault(); // Enter must not submit the whole form
              add(text);
            } else if (e.key === "Backspace" && text === "" && tags.length > 0) {
              remove(tags[tags.length - 1]);
            }
          }}
          onBlur={() => text.trim() && add(text)}
          list={suggestions.length ? listId : undefined}
          maxLength={maxLength * 4}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
        />
        <Button type="button" variant="outline" onClick={() => add(text)} disabled={disabled || text.trim() === ""}>
          Add
        </Button>
      </div>
      {suggestions.length > 0 && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-[11px] text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-[11px] text-red-300">
          {error}
        </p>
      )}
      <p id={`${id}-status`} className="sr-only" role="status" aria-live="polite">
        {notice}
      </p>
    </div>
  );
}
