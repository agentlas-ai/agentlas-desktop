"use client";

import { useState } from "react";
import { ProjectSettingsModal } from "@/components/ProjectSettingsModal";
import { WorkHome } from "@/components/WorkHome";
import { navigate } from "@/lib/navigation";

/** Keep old links usable while project creation now lives in a dialog. */
export default function NewProjectPage() {
  const [open, setOpen] = useState(true);
  return <><WorkHome />{open && <ProjectSettingsModal request={{ mode: "create" }} onClose={() => { setOpen(false); navigate("/workspace"); }} onSaved={(project) => { setOpen(false); navigate(`/project/detail?id=${encodeURIComponent(project.id)}`); }} />}</>;
}
