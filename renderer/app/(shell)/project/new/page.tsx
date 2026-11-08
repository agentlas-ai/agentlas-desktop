"use client";

import { useState } from "react";
import { ProjectSettingsModal } from "@/components/ProjectSettingsModal";
import { navigate } from "@/lib/navigation";

/** Keep old links usable while project creation has a dedicated screen. */
export default function NewProjectPage() {
  const [open, setOpen] = useState(true);
  return <>{open && <ProjectSettingsModal request={{ mode: "create" }} onClose={() => { setOpen(false); navigate("/workspace"); }} onSaved={(project) => { setOpen(false); navigate(`/project/detail?id=${encodeURIComponent(project.id)}`); }} />}</>;
}
