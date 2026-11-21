"use client";

import { useState } from "react";
import { ProjectSettingsModal } from "@/components/ProjectSettingsModal";
import { navigate } from "@/lib/navigation";
import { openNewChatStart } from "@/lib/new-chat-start";

/** Keep old links usable while project creation has a dedicated screen. */
export default function NewProjectPage() {
  const [open, setOpen] = useState(true);
  return <>{open && <ProjectSettingsModal request={{ mode: "create" }} onClose={() => { setOpen(false); navigate("/workspace"); }} onSaved={(project) => { setOpen(false); openNewChatStart({ projectId: project.id, projectName: project.name }); navigate("/workspace"); }} />}</>;
}
