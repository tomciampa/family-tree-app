import { FamilyTree } from "@/components/family-tree";
import type { Tables } from "@/lib/supabase/database.types";

type Person = Tables<"people">;
type UnionRow = Tables<"unions">;
type UnionChild = Tables<"union_children">;

const now = "2026-07-08T00:00:00Z";

const people: Person[] = [
  { id: "1", name: "Grandpa Al", birth_estimate: "1900", death_estimate: "1970", notes: null, is_placeholder: false, is_root: true, created_at: now },
  { id: "2", name: "Grandma Bea", birth_estimate: "1902", death_estimate: "1975", notes: null, is_placeholder: false, is_root: true, created_at: now },
  { id: "3", name: "Carl", birth_estimate: "1925", death_estimate: null, notes: null, is_placeholder: false, is_root: false, created_at: now },
  { id: "4", name: "Grandpa Dan", birth_estimate: "1898", death_estimate: "1960", notes: null, is_placeholder: false, is_root: true, created_at: now },
  { id: "5", name: "Grandma Edna", birth_estimate: "1901", death_estimate: "1980", notes: null, is_placeholder: false, is_root: true, created_at: now },
  { id: "6", name: "Frances", birth_estimate: "1927", death_estimate: null, notes: null, is_placeholder: false, is_root: false, created_at: now },
  { id: "7", name: "Gina", birth_estimate: "1950", death_estimate: null, notes: null, is_placeholder: false, is_root: false, created_at: now },
  { id: "8", name: "Hank", birth_estimate: "1952", death_estimate: null, notes: null, is_placeholder: false, is_root: false, created_at: now },
  { id: "9", name: "Irene", birth_estimate: "1930", death_estimate: null, notes: null, is_placeholder: false, is_root: true, created_at: now },
  { id: "10", name: "Jack", birth_estimate: "1955", death_estimate: null, notes: null, is_placeholder: false, is_root: false, created_at: now },
  { id: "11", name: "Karen (unplaced)", birth_estimate: "1980", death_estimate: null, notes: null, is_placeholder: false, is_root: false, created_at: now },
];

const unions: UnionRow[] = [
  { id: "u1", parent1_id: "1", parent2_id: "2", note: "m. 1922", created_at: now },
  { id: "u2", parent1_id: "4", parent2_id: "5", note: "m. 1920", created_at: now },
  { id: "u3", parent1_id: "3", parent2_id: "6", note: "m. 1948", created_at: now },
  { id: "u4", parent1_id: "3", parent2_id: "9", note: "m. 1960 (2nd marriage)", created_at: now },
];

const unionChildren: UnionChild[] = [
  { union_id: "u1", child_id: "3" },
  { union_id: "u2", child_id: "6" },
  { union_id: "u3", child_id: "7" },
  { union_id: "u3", child_id: "8" },
  { union_id: "u4", child_id: "10" },
];

export default function DevTreePreview() {
  return (
    <main className="min-h-screen p-8">
      <FamilyTree people={people} unions={unions} unionChildren={unionChildren} />
    </main>
  );
}
