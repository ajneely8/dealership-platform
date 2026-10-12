"use client";

import type { SceneProps } from "../types";
import { AtlasScene } from "./atlas";
import { BlazeScene } from "./blaze";
import { CharlieScene } from "./charlie";
import { EchoScene } from "./echo";
import { HunterScene } from "./hunter";
import { NovaScene } from "./nova";
import { OrionScene } from "./orion";
import { SageScene } from "./sage";
import { SentinelScene } from "./sentinel";

/** Picks the scene for an agent. Each one draws only from the props it is given. */
export function AgentScene(props: SceneProps) {
  switch (props.agentKey) {
    case "nova":
      return <NovaScene {...props} />;
    case "charlie":
      return <CharlieScene {...props} />;
    case "sage":
      return <SageScene {...props} />;
    case "hunter":
      return <HunterScene {...props} />;
    case "atlas":
      return <AtlasScene {...props} />;
    case "blaze":
      return <BlazeScene {...props} />;
    case "orion":
      return <OrionScene {...props} />;
    case "echo":
      return <EchoScene {...props} />;
    case "sentinel":
      return <SentinelScene {...props} />;
  }
}
