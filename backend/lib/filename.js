// ATS best practice: no spaces, no special characters, name + "Resume" +
// company/role somewhere in the filename. Recruiters and some ATS parsers
// use the filename itself as a weak signal, and a messy name like
// "Resume(3)_final_FINAL2.pdf" reads as sloppy.

function slug(value, fallback) {
  if (!value) return fallback;
  return String(value)
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}

export function buildFilename({ firstName, lastName, company, roleTitle }) {
  const first = slug(firstName, "Candidate");
  const last = slug(lastName, "Resume");
  const co = slug(company, "");
  const role = slug(roleTitle, "");

  const parts = [first, last, "Resume"];
  if (co) parts.push(co);
  else if (role) parts.push(role);

  return parts.join("_") + ".pdf";
}
