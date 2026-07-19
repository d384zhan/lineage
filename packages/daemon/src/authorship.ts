import type {
  Actor,
  AgentQuestion,
  GitIdentity,
  RepositoryAuthorship,
} from "@lineage/contracts";

type CommitAttribution = RepositoryAuthorship["recentRecipientCommits"][number];

function git(cwd: string, args: string[]): string | undefined {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return undefined;
  return new TextDecoder().decode(result.stdout);
}

function ownership(
  author: GitIdentity,
  identities: readonly GitIdentity[],
): Pick<CommitAttribution, "belongsToRecipient" | "matchBasis"> {
  const email = author.email.trim().toLowerCase();
  if (identities.some((identity) => identity.email.trim().toLowerCase() === email)) {
    return { belongsToRecipient: true, matchBasis: "email" };
  }
  const name = author.name.trim().toLowerCase();
  if (identities.some((identity) => identity.name.trim().toLowerCase() === name)) {
    return { belongsToRecipient: true, matchBasis: "name" };
  }
  return { belongsToRecipient: false };
}

function parseCommits(raw: string, identities: readonly GitIdentity[]): CommitAttribution[] {
  return raw
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha = "", name = "", email = "", authoredAt = "", ...summary] = record.split("\x1f");
      const author = { name, email };
      return {
        sha,
        summary: summary.join("\x1f"),
        author,
        authoredAt,
        ...ownership(author, identities),
      };
    })
    .filter((commit) => commit.sha.length >= 7 && !Number.isNaN(Date.parse(commit.authoredAt)));
}

const FORMAT = "%H%x1f%aN%x1f%aE%x1f%aI%x1f%s%x1e";

export async function resolveRepositoryAuthorship(
  cwd: string,
  recipient: Actor,
  question: AgentQuestion,
): Promise<RepositoryAuthorship | undefined> {
  const identities = recipient.gitIdentities ?? [];
  const raw = git(cwd, [
    "log",
    "--branches",
    "--remotes",
    "--tags",
    "--use-mailmap",
    "-n",
    "500",
    `--format=${FORMAT}`,
  ]);
  if (raw === undefined) return undefined;
  const commits = parseCommits(raw, identities);
  const recipientCommits = commits.filter((commit) => commit.belongsToRecipient);
  const referencedShas = [...new Set(
    question.evidence
      .filter((item) => item.kind === "commit")
      .map((item) => item.value),
  )];
  const referencedCommits: CommitAttribution[] = [];
  for (const sha of referencedShas) {
    const referenced = git(cwd, ["show", "-s", "--use-mailmap", `--format=${FORMAT}`, sha]);
    if (referenced) referencedCommits.push(...parseCommits(referenced, identities).slice(0, 1));
  }
  return {
    inspectedCommitCount: commits.length,
    recipientCommitCount: recipientCommits.length,
    recentRecipientCommits: recipientCommits.slice(0, 20),
    referencedCommits,
  };
}
