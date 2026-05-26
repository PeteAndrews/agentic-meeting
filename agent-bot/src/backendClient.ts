import { config } from "./config.js";

type AgentEventPayload = {
  roomName: string;
  participantId?: string;
  eventType: string;
  payload?: Record<string, unknown>;
};

export async function postAgentEvent(input: AgentEventPayload): Promise<void> {
  const body = {
    roomName: input.roomName,
    participantId: input.participantId ?? "agent-c",
    role: "agent",
    condition: "HA",
    tsMs: Date.now(),
    eventType: input.eventType,
    payload: input.payload ?? {},
  };

  try {
    const response = await fetch(`${config.backendUrl}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      console.error("Failed posting event:", response.status, text);
    }
  } catch (error) {
    console.error("Failed posting event:", error);
  }
}
