import type { User } from "@/.fluxfast/types.generated";

export function UserCard({ user }: { user: User }) {
  return (
    <article aria-label="Featured user">
      <strong>{user.name}</strong>
      <span>{user.email}</span>
    </article>
  );
}
