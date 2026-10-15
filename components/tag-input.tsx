"use client";

import { useState } from "react";
import { Button, Input } from "@/components/ui";

/**
 * Free-form tag input. Each tag is emitted as a named hidden input so the
 * server action can read them with formData.getAll(name).
 */
export function TagInput({
  name,
  label,
  hint,
  placeholder,
  defaultValues = [],
}: {
  name: string;
  label: string;
  hint?: string;
  placeholder?: string;
  defaultValues?: string[];
}) {
  const [tags, setTags] = useState<string[]>(defaultValues);
  const [draft, setDraft] = useState("");

  function addTag() {
    const value = draft.trim();
    if (!value) return;
    if (!tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setTags([...tags, value]);
    }
    setDraft("");
  }

  function removeTag(tag: string) {
    setTags(tags.filter((t) => t !== tag));
  }

  return (
    <div>
      <span className="mb-1 block text-[15px] font-medium text-slate-700">
        {label}
      </span>

      {tags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary-100 py-1 pl-3 pr-2 text-[15px] font-medium text-primary-800"
            >
              {tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                aria-label={`Remove ${tag}`}
                className="flex h-5 w-5 items-center justify-center rounded-full text-primary-600 hover:bg-primary-200"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              addTag();
            }
          }}
          placeholder={placeholder}
          autoComplete="off"
        />
        <Button type="button" variant="secondary" onClick={addTag}>
          Add
        </Button>
      </div>

      {hint && <span className="mt-1 block text-sm text-slate-400">{hint}</span>}

      {tags.map((tag) => (
        <input key={tag} type="hidden" name={name} value={tag} />
      ))}
    </div>
  );
}
