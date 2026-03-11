import type { JobPosting, RankedJob, SearchProfile } from './types';

function includesNormalized(haystack: string, needles: string[]): boolean {
  const value = haystack.toLowerCase();
  return needles.some((needle) => value.includes(needle.toLowerCase()));
}

export function rankJobAgainstProfile(
  profile: SearchProfile,
  job: JobPosting,
): RankedJob {
  let score = 0;
  const reasons: string[] = [];
  const matchedSkills = profile.skills.filter((skill) =>
    job.description?.toLowerCase().includes(skill.toLowerCase()) ||
    job.summary.toLowerCase().includes(skill.toLowerCase()) ||
    job.tags.some((tag) => tag.toLowerCase() === skill.toLowerCase()),
  );
  const missingSkills = profile.skills.filter((skill) => !matchedSkills.includes(skill)).slice(0, 5);

  if (includesNormalized(job.title, profile.targetTitles)) {
    score += 0.4;
    reasons.push('Strong title match');
  } else if (includesNormalized(job.title, profile.relatedTitles)) {
    score += 0.25;
    reasons.push('Related title match');
  }

  if (matchedSkills.length > 0) {
    const skillScore = Math.min(0.4, matchedSkills.length * 0.05);
    score += skillScore;
    reasons.push(`Matched skills: ${matchedSkills.slice(0, 5).join(', ')}`);
  }

  if (
    profile.preferredLocations.length === 0 ||
    includesNormalized(job.location, profile.preferredLocations) ||
    includesNormalized(job.remoteType ?? '', ['remote'])
  ) {
    score += 0.15;
    reasons.push('Location or remote preference fits');
  }

  if (profile.excludedKeywords.some((keyword) => job.summary.toLowerCase().includes(keyword.toLowerCase()))) {
    score -= 0.25;
    reasons.push('Contains excluded keywords');
  }

  if (job.salary) {
    score += 0.05;
    reasons.push('Compensation listed');
  }

  if (job.publishedAt) {
    const published = new Date(job.publishedAt);
    const ageHours = Math.max(0, (Date.now() - published.getTime()) / (1000 * 60 * 60));
    if (ageHours <= 72) {
      score += 0.05;
      reasons.push('Fresh posting');
    }
  }

  return {
    job,
    score: Math.max(0, Math.min(1, Number(score.toFixed(3)))),
    reasons,
    matchedSkills,
    missingSkills,
  };
}
