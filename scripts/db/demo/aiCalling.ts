/**
 * Northwind's AI calling: three cloud calling numbers (two linked, one being
 * set up), the IPs they go out from, and three AI calling campaigns — one
 * that has run for three weeks, one for a week and a half, and a draft —
 * with every call the agent placed (transcripts and the outcome it
 * recorded), every WhatsApp it sent from the number, a lead who rang back
 * and was answered by the agent, and a rep's "Call now" through a number.
 *
 * The leads are people Northwind emailed who never replied, now given phone
 * numbers (US 555-01xx and UK 07700 900xxx, both reserved for fiction).
 *
 * Rows are written directly with their own times, in the shapes the engine
 * leaves (src/lib/calls/aiCampaigns/engineRules.ts): step runs keyed
 * reach:/chase:/booking-link/inbound:, booking codes, follow-up dates. Where
 * a lead reaches the CRM it goes through the app's own functions
 * (setLeadStage, syncCallFollowUp, forwardWhatsappInboundToCrm), and the
 * events they stamp "now" are moved to the call's time. Nothing calls out,
 * and no number is held open by a worker, so the engine never acts on it.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  callCampaignContacts,
  callCampaignStations,
  callCampaignStepRuns,
  callCampaigns,
  callSessions,
  callingProxies,
  callingStations,
  stationMessageJobs,
} from "@/lib/calls/schema";
import type { AgentOutcome, AgentOutcomeKind, CallTranscript, CampaignContactStage, ContactCallStatus } from "@/lib/calls/contract";
import type { AiCallResult, AiCampaignGoal, AiCampaignStep, AiContactStatus } from "@/lib/calls/aiCampaigns/contract";
import { BOOKING_LINK_KEY, BOOKING_REVIEW_MS, bookingLinkFor, newBookingCode } from "@/lib/calls/aiCampaigns/engineRules";
import { setLeadStage } from "@/lib/calls/leadStage";
import { DO_NOT_CONTACT_SUBCATEGORY_KEY } from "@/lib/calls/leadStageRules";
import { syncCallFollowUp } from "@/lib/calls/crmFollowUp";
import { crmSubcategories } from "@/lib/crm/schema";
import { people } from "@/lib/leads/schema";
import { suppressionList } from "@/lib/outreach/schema";
import { forwardWhatsappInboundToCrm } from "@/lib/whatsapp/crmBridge";
import { whatsappAccounts, whatsappChats, whatsappMessages } from "@/lib/whatsapp/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import type { ReplyIntent } from "./content";
import { DAY, HOUR, MINUTE, count, createRng, daysAgo, type DemoContext, type DemoPerson } from "./context";

// ---------------------------------------------------------------------------
// The numbers
// ---------------------------------------------------------------------------

type StationKey = "us" | "uk" | "spare";

const STATIONS: {
  key: StationKey;
  name: string;
  phone: string;
  status: "active" | "onboarding";
  createdDaysAgo: number;
  automationDaysAgo: number | null;
  callsPerDay: number | null;
  /** UTC hours its calls go out in (9–5 local). */
  hours: [number, number];
  proxy: { label: string; host: string; country: string; timezone: string } | null;
}[] = [
  {
    key: "us", name: "US line · Riya", phone: "+12025550110", status: "active", createdDaysAgo: 34, automationDaysAgo: 26, callsPerDay: 40,
    hours: [13, 21], proxy: { label: "Static ISP · Virginia", host: "203.0.113.24", country: "US", timezone: "America/New_York" },
  },
  {
    key: "uk", name: "UK line · Arjun", phone: "+447700900050", status: "active", createdDaysAgo: 21, automationDaysAgo: 12, callsPerDay: null,
    hours: [9, 17], proxy: { label: "Static ISP · London", host: "203.0.113.57", country: "GB", timezone: "Europe/London" },
  },
  {
    key: "spare", name: "Spare number", phone: "+12025550111", status: "onboarding", createdDaysAgo: 1, automationDaysAgo: null, callsPerDay: null,
    hours: [13, 21], proxy: null,
  },
];

// ---------------------------------------------------------------------------
// The campaigns
// ---------------------------------------------------------------------------

type CampaignKey = "intro" | "trials" | "summit";

type CampaignDef = {
  key: CampaignKey;
  name: string;
  description: string;
  goal: AiCampaignGoal;
  agentName: string;
  agentVoice: string;
  stations: StationKey[];
  createdDaysAgo: number;
  /** Null: a draft, never launched. */
  launchedDaysAgo: number | null;
  bookingUrl: string | null;
  bookingMessage: string | null;
  maxCallbacks: number;
  instructions: string;
  steps: AiCampaignStep[];
  chaseSteps: AiCampaignStep[];
};

const CAMPAIGNS: CampaignDef[] = [
  {
    key: "intro",
    name: "Email non-responders · AI intro call",
    description: "People who opened our account-research emails but never wrote back get a short call from the AI agent, a WhatsApp nudge, and one more try.",
    goal: "either",
    agentName: "Riya",
    agentVoice: "Kore",
    stations: ["us", "uk"],
    createdDaysAgo: 27,
    launchedDaysAgo: 24,
    bookingUrl: "https://cal.northwind.example/alex/intro-call",
    bookingMessage: "Hi {{firstName}}, {{agentName}} from Northwind here, thanks for the chat just now! Here's the link to pick a time with Alex that suits you: {{bookingLink}}",
    maxCallbacks: 2,
    instructions: [
      "We emailed these people about Northwind Signal, which tells sales teams which accounts to work each week and why. They opened the email but did not reply.",
      "Find out how their reps decide which accounts to contact, and whether research takes too long. If it does, offer a 20-minute intro call with Alex, our Head of Sales.",
      "If they would rather hear from a person first, say someone from the team will call them back and agree on a time.",
      "Never quote prices on the call; say the team will go through options on the intro call.",
    ].join("\n"),
    steps: [
      { id: "call-1", kind: "call", delayHours: 0, instructions: "First call: say you are following up on the email Northwind sent about account research, and ask whether it is a problem for their team." },
      { id: "call-2", kind: "call", delayHours: 24, instructions: "Second try: you called yesterday and could not reach them; mention it in one line, then the same as the first call." },
      {
        id: "message-1", kind: "message", delayHours: 2,
        body: "Hi {{firstName}}, {{agentName}} from Northwind here. I tried calling about the note we sent on account research at {{company}}. Is there a better time for a quick 5-minute chat?",
      },
      { id: "call-3", kind: "call", delayHours: 48, instructions: "Last try: keep it short and respectful of their time. If it is not relevant, thank them and wrap up." },
    ],
    chaseSteps: [
      { id: "chase-message-1", kind: "message", delayHours: 24, body: "Hi {{firstName}}, just a reminder from {{agentName}} at Northwind: here's the link to grab 20 minutes with Alex whenever suits you: {{bookingLink}}" },
      { id: "chase-call-1", kind: "call", delayHours: 48, instructions: "They agreed to an intro call but have not booked it. Ask kindly whether the link worked, and offer to have Alex call them instead." },
    ],
  },
  {
    key: "trials",
    name: "Quiet trial sign-ups · hand to an AE",
    description: "Pilot sign-ups who have not logged in for a week. The agent checks in, finds out what got in the way, and hands the interested ones to Jordan.",
    goal: "human_callback",
    agentName: "Arjun",
    agentVoice: "Achird",
    stations: ["uk"],
    createdDaysAgo: 11,
    launchedDaysAgo: 9,
    bookingUrl: null,
    bookingMessage: null,
    maxCallbacks: 1,
    instructions: [
      "These people started a free two-seat pilot of Northwind Signal and have not logged in for a week.",
      "Ask what got in the way (setup, time, the CRM connection) without making them feel chased. If they still want to try it, agree when Jordan, their account executive, will call to help set it up.",
    ].join("\n"),
    steps: [
      { id: "call-1", kind: "call", delayHours: 0, instructions: "Check in on the pilot: ask how it is going and what got in the way." },
      { id: "message-1", kind: "message", delayHours: 4, body: "Hi {{firstName}}, {{agentName}} from Northwind. I tried calling to see how your pilot is going. If anything got stuck in setup, reply here and Jordan from our team will help." },
      { id: "call-2", kind: "call", delayHours: 48, instructions: "Second and last try: keep it to a minute." },
    ],
    chaseSteps: [],
  },
  {
    key: "summit",
    name: "RevOps Summit list · AI follow-up",
    description: "People who stopped by our stand at the RevOps Summit. Draft: waiting for the final list before launch.",
    goal: "book_meeting",
    agentName: "Riya",
    agentVoice: "Kore",
    stations: ["us"],
    createdDaysAgo: 2,
    launchedDaysAgo: null,
    bookingUrl: "https://cal.northwind.example/alex/intro-call",
    bookingMessage: null,
    maxCallbacks: 2,
    instructions: "They met us at the RevOps Summit stand. Remind them where you met, ask what stood out, and offer a 20-minute call with Alex.",
    steps: [
      { id: "call-1", kind: "call", delayHours: 0, instructions: "First call: mention the RevOps Summit stand." },
      { id: "message-1", kind: "message", delayHours: 2, body: "Hi {{firstName}}, {{agentName}} from Northwind, we met at the RevOps Summit. I tried calling; is there a good time for a quick chat?" },
      { id: "call-2", kind: "call", delayHours: 48, instructions: "Second try, short." },
    ],
    chaseSteps: [
      { id: "chase-message-1", kind: "message", delayHours: 24, body: "Hi {{firstName}}, here's the link to pick a time with Alex: {{bookingLink}}" },
    ],
  },
];

// ---------------------------------------------------------------------------
// What the agent says: one script per outcome. {agent} {lead} {company} {industry} {when}
// ---------------------------------------------------------------------------

type Spk = "rep" | "lead";
type Script = {
  outcome: AgentOutcomeKind;
  /** The transcript's summary. */
  summary: string;
  /** The one sentence the agent recorded. */
  outcomeSummary: string;
  lines: (readonly [Spk, string])[];
};
const A = (text: string) => ["rep", text] as const;
const P = (text: string) => ["lead", text] as const;

const MEETING: Script[] = [
  {
    outcome: "meeting_booked",
    summary: "{lead} runs a team of about ten reps at {company} who pick accounts from a shared spreadsheet; research eats most of Monday. The agent explained what Signal does and {lead} agreed to a 20-minute intro call with Alex, with a booking link to follow on WhatsApp.",
    outcomeSummary: "Interested; agreed to an intro call with Alex, {when}.",
    lines: [
      A("Hi, is this {lead}? This is {agent}, I'm an AI assistant calling for Northwind. We emailed you last week about account research. Do you have a minute?"),
      P("Oh, an AI? Okay... yes, I've got a minute."),
      A("Thanks. Quick question: how do your reps decide which accounts to work each week?"),
      P("Honestly, there's a shared spreadsheet and everyone grabs what looks good. Monday mornings are basically research."),
      A("That's really common. Northwind Signal scores your accounts against your ideal customer profile and gives each rep a short list every Monday, with the reason for each one."),
      P("Hm. That would save us a lot of time, to be honest."),
      A("Would a 20-minute intro call with Alex, our Head of Sales, be useful? He can show it on accounts like yours."),
      P("Sure. {when} would work best for me."),
      A("Great. I'll send you a booking link on WhatsApp right after this call so you can pick the exact time. Is this number fine for that?"),
      P("Yes, this number's fine."),
      A("Perfect. Thanks {lead}, have a good day."),
      P("You too, bye."),
    ],
  },
  {
    outcome: "meeting_booked",
    summary: "{lead} said their {industry} team already uses a sequencer but struggles to decide who to put into it. The agent explained that Signal sits in front of the sequencer. {lead} asked for a short call with someone who can show it, and agreed to book a slot from the WhatsApp link.",
    outcomeSummary: "Agreed to a call with Alex to see it in front of their sequencer; {when}.",
    lines: [
      A("Hello {lead}, this is {agent}, an AI assistant calling on behalf of Northwind, about the email we sent on account prioritisation. Is now an okay time?"),
      P("Two minutes, I'm between meetings."),
      A("I'll be quick. Do your reps struggle with who to contact, or is that already sorted?"),
      P("We have a sequencer, so the sending part is fine. Deciding who goes into it is the mess."),
      A("That's exactly where Signal fits. It doesn't replace the sequencer; it decides who and why, and feeds the tool you already have."),
      P("Okay, that's interesting. Can someone show me?"),
      A("Yes. Alex from our team does a 20-minute intro. Would {when} suit you?"),
      P("{when} is good."),
      A("Great, I'll send a link on WhatsApp so you can choose the exact time. Thank you, {lead}."),
      P("Thanks, bye."),
    ],
  },
];

const INBOUND_MEETING: Script = {
  outcome: "meeting_booked",
  summary: "{lead} called back after a missed call and a WhatsApp from the number. They had seen the email and wanted to know what it was about. The agent explained Signal briefly; {lead} agreed to an intro call with Alex and asked for the link on WhatsApp.",
  outcomeSummary: "Called us back; agreed to an intro call with Alex, {when}.",
  lines: [
    A("Hello, this is {agent} at Northwind. I'm an AI assistant. How can I help?"),
    P("Hi, I had a missed call and a WhatsApp from this number. Something about account research?"),
    A("Yes, thanks for calling back, {lead}. We emailed you about Northwind Signal. It tells sales teams which accounts to work each week, and why."),
    P("Right, I saw the email. We're hiring two more SDRs, so it might be good timing."),
    A("Then an intro call with Alex, our Head of Sales, could be useful. About 20 minutes. Would {when} work?"),
    P("Yes, {when} is fine. Send me the link."),
    A("I'll send it on WhatsApp right after this call. Thanks for calling back, {lead}."),
    P("No problem, bye."),
  ],
};

const HANDOFF_C1: Script = {
  outcome: "human_callback",
  summary: "{lead} is evaluating tools for next quarter and has specific questions about the HubSpot sync and data security that they want to go through with a person. The agent agreed that someone from the team will call {when}.",
  outcomeSummary: "Wants a person to go through HubSpot sync and security; call {when}.",
  lines: [
    A("Hi {lead}, this is {agent}, an AI assistant calling for Northwind about the email we sent. Have you got a minute?"),
    P("Yes, actually. We're looking at tools for next quarter."),
    A("Good timing then. What matters most to you?"),
    P("Two things: it has to sync both ways with HubSpot, and our security team will want to see a SOC 2 report."),
    A("Both are covered, but I'd rather someone from our team goes through it with you properly. Could they call you?"),
    P("Yes, a person would be better for that. {when} works."),
    A("Noted: someone from the team will call you {when}. Thank you, {lead}."),
    P("Great, thanks."),
  ],
};

const HANDOFF_TRIALS: Script[] = [
  {
    outcome: "interested",
    summary: "{lead} signed up for the pilot but got stuck connecting HubSpot and then got busy. Still keen to try it on their own accounts; agreed that Jordan will call {when} to finish setup together.",
    outcomeSummary: "Stuck on the HubSpot connection; wants Jordan to help set it up, {when}.",
    lines: [
      A("Hi {lead}, this is {agent}, an AI assistant from Northwind. You started a pilot with us last week; I'm calling to see how it's going."),
      P("Ah, yes. Honestly, I got stuck connecting HubSpot and then the week got away from me."),
      A("That happens a lot. Would it help if Jordan, your account executive, called to set it up with you? It usually takes fifteen minutes."),
      P("That would actually be great. {when} if possible."),
      A("I'll let Jordan know: {when}. Thanks {lead}."),
      P("Thank you."),
    ],
  },
  {
    outcome: "interested",
    summary: "{lead} has been travelling and has not opened the pilot. Still interested, mainly in the weekly account list for their {industry} team. Asked for a walkthrough with a person {when}.",
    outcomeSummary: "Travelling, has not started; wants a walkthrough with Jordan, {when}.",
    lines: [
      A("Hello {lead}, it's {agent}, an AI assistant calling from Northwind about your pilot. Is now okay?"),
      P("Sure. I haven't even logged in, I've been travelling."),
      A("No problem at all. Is it still something you'd like to try?"),
      P("Yes, the weekly account list is the bit I care about."),
      A("Would a short walkthrough with Jordan from our team help you get started?"),
      P("Yes. {when} would be best."),
      A("Done. Jordan will call you {when}. Safe travels, {lead}."),
      P("Thanks!"),
    ],
  },
];

const CALL_BACK: Script[] = [
  {
    outcome: "call_back",
    summary: "{lead} picked up while driving and asked to be called back. The agent agreed to call {when}.",
    outcomeSummary: "Driving; asked to be called back {when}.",
    lines: [
      A("Hi {lead}, this is {agent}, an AI assistant calling for Northwind. Is now a good time?"),
      P("Not really, I'm driving. Can you call me back?"),
      A("Of course. When suits you?"),
      P("{when}."),
      A("I'll call you {when}. Drive safe."),
    ],
  },
  {
    outcome: "call_back",
    summary: "{lead} was about to go into a meeting but said the topic is relevant; asked for a call {when}.",
    outcomeSummary: "In a meeting; relevant topic, call back {when}.",
    lines: [
      A("Hello {lead}, it's {agent}, an AI assistant from Northwind, following up on our email about account research."),
      P("I saw it. It's relevant, but I'm walking into a meeting."),
      A("No problem. Shall I call you back later?"),
      P("Yes, {when} is better."),
      A("Great, I'll call {when}. Thanks!"),
    ],
  },
];

const NOT_INTERESTED: Script[] = [
  {
    outcome: "not_interested",
    summary: "{lead} said they are happy with their current process and have no plans to change tools this year. The agent thanked them and ended the call.",
    outcomeSummary: "Happy with their current process; no plans to change this year.",
    lines: [
      A("Hi {lead}, this is {agent}, an AI assistant calling for Northwind about the email on account research. Have you got a minute?"),
      P("I did see it. Honestly, we're happy with how we do things now."),
      A("Understood. Is that something that might change later in the year?"),
      P("Not this year, no."),
      A("Thanks for telling me. I won't take more of your time. Have a good day, {lead}."),
      P("You too."),
    ],
  },
  {
    outcome: "not_interested",
    summary: "{lead} said their company just signed a two-year contract with another vendor. Not interested for now.",
    outcomeSummary: "Just signed a two-year contract with another vendor.",
    lines: [
      A("Hello {lead}, it's {agent}, an AI assistant from Northwind. We emailed about helping your reps prioritise accounts."),
      P("We actually just signed with another vendor. Two-year contract."),
      A("Ah, makes sense. Thanks for letting me know, I'll make a note."),
      P("No worries."),
      A("All the best with it, {lead}. Bye."),
    ],
  },
  {
    outcome: "not_interested",
    summary: "{lead} said the team is too small to need a tool like this; two reps work from a short list. Not interested.",
    outcomeSummary: "Team of two reps; does not need it.",
    lines: [
      A("Hi {lead}, this is {agent}, an AI assistant calling on behalf of Northwind. Do you have a moment?"),
      P("Briefly, yes."),
      A("How do your reps decide which accounts to work each week?"),
      P("There are two of us, and we have maybe fifty target accounts. We don't really need software for that."),
      A("That's fair. Thank you for your time, {lead}."),
    ],
  },
];

const DO_NOT_CONTACT: Script = {
  outcome: "do_not_contact",
  summary: "{lead} asked not to be called again and to be removed from the list. The agent confirmed and ended the call.",
  outcomeSummary: "Asked to be removed and not contacted again.",
  lines: [
    A("Hi {lead}, this is {agent}, an AI assistant calling for Northwind."),
    P("Please take me off your list. I don't want calls like this."),
    A("Understood, I'm sorry for the interruption. You won't be contacted again."),
  ],
};

const REMOTE_REP: Script = {
  outcome: "other",
  summary: "Jordan called {lead} back from the US line as agreed. They went through the HubSpot sync and the SOC 2 report; {lead} asked for a demo for their RevOps lead next week, which Jordan will send.",
  outcomeSummary: "",
  lines: [
    A("Hi {lead}, it's Jordan from Northwind. Our assistant said you had questions about HubSpot and security?"),
    P("Hi Jordan, yes. Does the sync go both ways?"),
    A("It does: scores and the reason for each account are written onto the HubSpot company, and changes in HubSpot come back within a few minutes."),
    P("Good. And security?"),
    A("We're SOC 2 Type II; I'll send you the report and our DPA today so your security team can start."),
    P("That helps. Could you show it to our RevOps lead next week?"),
    A("Of course. I'll send a couple of times for a demo along with the report."),
    P("Perfect, thanks Jordan."),
  ],
};

const REPLIES: { intent: ReplyIntent; body: string }[] = [
  { intent: "Information Requested", body: "Hi, sorry I missed your calls. Could you send me something by email first? I'd rather read about it before a call." },
  { intent: "Meeting Requested", body: "Sorry, I've been travelling all week. Happy to talk, can someone from your team call me Thursday afternoon?" },
];

// ---------------------------------------------------------------------------
// Lead plans: what happens to each lead
// ---------------------------------------------------------------------------

type Target =
  | "booked" | "booked_past" | "chasing" | "chasing_due" | "handoff" | "handoff_rep" | "callback"
  | "not_interested" | "replied" | "unreached" | "reaching" | "reaching_today" | "queued" | "stopped" | "failed"
  | "booked_inbound" | "draft";

const MIX: Record<CampaignKey, [Target, number][]> = {
  intro: [
    ["booked", 4], ["booked_past", 1], ["booked_inbound", 1], ["chasing", 2], ["chasing_due", 2], ["handoff", 2], ["handoff_rep", 1],
    ["callback", 3], ["not_interested", 7], ["replied", 2], ["unreached", 6], ["reaching", 5], ["reaching_today", 3], ["queued", 3],
    ["stopped", 1], ["failed", 1],
  ],
  trials: [["handoff", 5], ["not_interested", 3], ["callback", 2], ["reaching", 2], ["reaching_today", 1], ["unreached", 2], ["queued", 1]],
  summit: [["draft", 8]],
};

/** How many days ago a lead with this target was enrolled. */
const ENROLLED: Record<Target, [number, number]> = {
  booked: [9, 3], booked_past: [20, 14], booked_inbound: [8, 5], chasing: [2, 1], chasing_due: [6, 3], handoff: [12, 2], handoff_rep: [10, 6],
  callback: [1, 1], not_interested: [21, 2], replied: [9, 4], unreached: [22, 8], reaching: [2, 1], reaching_today: [0, 0], queued: [0, 0],
  stopped: [15, 5], failed: [18, 4], draft: [2, 1],
};

type PlannedCall = {
  id: string;
  stepKey: string | null;
  at: Date;
  result: AiCallResult;
  station: StationKey;
  direction: "outbound" | "inbound";
  remoteRep: boolean;
  script: Script | null;
  when: string | null;
  whenAt: Date | null;
};
type PlannedMessage = { id: string; stepKey: string; at: Date; body: string; station: StationKey; read: boolean };
type PlannedReply = { at: Date; body: string; intent: ReplyIntent; station: StationKey };

type LeadPlan = {
  id: string;
  campaign: CampaignDef;
  campaignId: string;
  person: DemoPerson;
  target: Target;
  enrolledAt: Date;
  station: StationKey | null;
  calls: PlannedCall[];
  messages: PlannedMessage[];
  reply: PlannedReply | null;
  status: AiContactStatus;
  step: number;
  nextAt: Date | null;
  callbacks: number;
  note: string | null;
  bookedAt: Date | null;
  meetingAt: Date | null;
  bookingCode: string | null;
  followUpAt: Date | null;
  stage: CampaignContactStage;
  instructions: string | null;
  crmStage: string | null;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const digitsOf = (phone: string) => phone.replace(/\D/g, "");
const preview = (body: string) => {
  const text = body.replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
};

function fill(text: string, v: Record<string, string>): string {
  return text.replace(/\{\{?(\w+)\}?\}/g, (match, key: string) => v[key] ?? match);
}

/** Start times for each line from how long it takes to say, with a pause between. */
function timeLines(lines: (readonly [Spk, string])[], offsetSeconds: number) {
  let t = offsetSeconds + 1;
  const utterances: CallTranscript["utterances"] = [];
  for (const [speaker, text] of lines) {
    utterances.push({ startSeconds: Math.round(t), speaker, text });
    const words = text.split(/\s+/).length;
    t += words / 2.4 + 1.1 + (words % 3) * 0.4;
  }
  return { utterances, talkSeconds: t - offsetSeconds + 2 };
}

export async function seedAiCalling(shared: DemoContext): Promise<void> {
  // Its own random stream: what the other modules drew must not change this module's story.
  const ctx: DemoContext = { ...shared, rand: createRng(41) };
  const org = currentOrganizationId();
  const now = ctx.now;
  const rand = ctx.rand;

  // ----------------------------------------------------------------- time
  const stationHours = (key: StationKey) => STATIONS.find((s) => s.key === key)!.hours;
  /** `d` or the next moment inside the station's calling hours on a weekday. */
  const inHours = (d: Date, key: StationKey): Date => {
    const [from, to] = stationHours(key);
    const x = new Date(d);
    if (x.getUTCHours() >= to) {
      x.setUTCDate(x.getUTCDate() + 1);
      x.setUTCHours(from, rand.int(0, 50), rand.int(0, 59), 0);
    } else if (x.getUTCHours() < from) {
      x.setUTCHours(from, rand.int(0, 50), rand.int(0, 59), 0);
    }
    while (x.getUTCDay() === 0 || x.getUTCDay() === 6) {
      x.setUTCDate(x.getUTCDate() + 1);
      x.setUTCHours(from, rand.int(0, 50), rand.int(0, 59), 0);
    }
    return x;
  };
  /** A weekday moment `days` ago inside the station's hours, never in the future. */
  const dayAt = (days: number, key: StationKey): Date => {
    const [from, to] = stationHours(key);
    const d = daysAgo(ctx, days);
    if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 2);
    if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(rand.int(from, to - 1), rand.int(0, 59), rand.int(0, 59), 0);
    if (d.getTime() > now.getTime()) return new Date(now.getTime() - rand.int(15, 150) * MINUTE);
    return d;
  };
  /** A future weekday at a round local-ish hour, `days` from `from`. */
  const futureAt = (from: Date, days: number, hourUtc: number): Date => {
    const d = new Date(from.getTime() + days * DAY);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(hourUtc, rand.pick([0, 30]), 0, 0);
    return d;
  };
  const whenText = (callAt: Date, at: Date): string => {
    const days = Math.round((Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - Date.UTC(callAt.getUTCFullYear(), callAt.getUTCMonth(), callAt.getUTCDate())) / DAY);
    const part = at.getUTCHours() < 16 ? "morning" : at.getUTCHours() < 19 ? "afternoon" : "late afternoon";
    if (days === 0) return `later today, after ${((at.getUTCHours() + 7) % 12) + 1}`;
    if (days === 1) return `tomorrow ${part}`;
    return `${WEEKDAYS[at.getUTCDay()]} ${part}`;
  };

  // ----------------------------------------------------------------- people
  const replied = new Set(ctx.replies.map((r) => r.personId));
  const suppressed = new Set(
    (await db.select({ email: suppressionList.email }).from(suppressionList).where(inOrg(suppressionList))).map((r) => r.email.toLowerCase()),
  );
  const candidates = rand.shuffle(
    ctx.pools.email.filter((p) => !replied.has(p.id) && !p.phone && !suppressed.has(p.email.toLowerCase()) && ["US", "UK", "IE", "CA"].includes(p.company.country)),
  );
  const needed = Object.values(MIX).reduce((n, mix) => n + mix.reduce((s, [, k]) => s + k, 0), 0);
  if (candidates.length < needed) throw new Error(`AI calling: ${candidates.length} people to call, ${needed} needed`);
  const chosen = candidates.slice(0, needed);

  // Numbers in ranges reserved for fiction; other modules use 212/415 and 07700 900100+.
  const areaCodes = ["718", "213", "702", "919", "720", "602", "503"];
  let us = 0;
  let uk = 600;
  for (const person of chosen) {
    person.phone =
      person.company.country === "UK" || person.company.country === "IE"
        ? `+447700900${String(uk++).padStart(3, "0")}`
        : `+1${areaCodes[Math.floor(us / 100) % areaCodes.length]}55501${String(us++ % 100).padStart(2, "0")}`;
    await db.update(people).set({ phone: person.phone }).where(and(inOrg(people), eq(people.id, person.id)));
  }

  // ----------------------------------------------------------------- stations
  const stationId = {} as Record<StationKey, string>;
  const accountId = {} as Record<StationKey, string>;
  for (const s of STATIONS) {
    const createdAt = daysAgo(ctx, s.createdDaysAgo);
    let proxyId: string | null = null;
    if (s.proxy) {
      const [proxy] = await db
        .insert(callingProxies)
        .values({
          organizationId: org,
          label: s.proxy.label,
          protocol: "http",
          host: s.proxy.host,
          port: 8080,
          country: s.proxy.country,
          timezone: s.proxy.timezone,
          provider: "Demo ISP",
          notes: "Sample data: a documentation address, nothing connects to it.",
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: callingProxies.id });
      proxyId = proxy!.id;
    }
    const linked = s.status === "active";
    const id = randomUUID();
    await db.insert(callingStations).values({
      organizationId: org,
      id,
      name: s.name,
      phone: s.phone,
      launcher: "cloak",
      status: s.status,
      linkUpdatedAt: linked ? new Date(createdAt.getTime() + 25 * MINUTE) : null,
      workerId: linked ? "demo-worker-1" : null,
      lastSeenAt: linked ? new Date(now.getTime() - rand.int(2, 9) * MINUTE) : null,
      proxyId,
      fingerprintSeed: rand.int(10000, 99999),
      profileKey: linked ? `calling-stations/${id}/profile.tar.gz` : null,
      profileBytes: linked ? rand.int(31, 46) * 1_048_576 : null,
      profileVersion: linked ? rand.int(9, 24) : 0,
      profileSavedAt: linked ? new Date(now.getTime() - rand.int(1, 9) * HOUR) : null,
      linkedPhone: linked ? s.phone : null,
      callsPerDay: s.callsPerDay,
      automationStartedAt: s.automationDaysAgo === null ? null : daysAgo(ctx, s.automationDaysAgo),
      createdAt,
      updatedAt: createdAt,
    });
    stationId[s.key] = id;
    const [account] = await db
      .insert(whatsappAccounts)
      .values({
        organizationId: org,
        unipileAccountId: `station:${id}`,
        name: s.name,
        phone: s.phone,
        status: linked ? "connected" : "disconnected",
        connectedAt: linked ? new Date(createdAt.getTime() + 25 * MINUTE) : null,
        provider: "station",
        stationId: id,
        createdAt,
        updatedAt: createdAt,
      })
      .returning({ id: whatsappAccounts.id });
    accountId[s.key] = account!.id;
  }
  count(ctx, "calling numbers (cloud stations)", STATIONS.length);

  // ----------------------------------------------------------------- campaigns
  const campaignId = {} as Record<CampaignKey, string>;
  for (const c of CAMPAIGNS) {
    const id = randomUUID();
    campaignId[c.key] = id;
    const createdAt = daysAgo(ctx, c.createdDaysAgo);
    await db.insert(callCampaigns).values({
      organizationId: org,
      id,
      name: c.name,
      description: c.description,
      status: c.launchedDaysAgo === null ? "paused" : "active",
      runBy: "ai",
      aiGoal: c.goal,
      aiInstructions: c.instructions,
      aiAgentName: c.agentName,
      aiAgentVoice: c.agentVoice,
      aiSteps: c.steps,
      aiChaseSteps: c.chaseSteps,
      aiBookingUrl: c.bookingUrl,
      aiBookingMessage: c.bookingMessage,
      aiMaxCallbacks: c.maxCallbacks,
      aiLaunchedAt: c.launchedDaysAgo === null ? null : daysAgo(ctx, c.launchedDaysAgo),
      createdAt,
      updatedAt: daysAgo(ctx, Math.min(c.createdDaysAgo, 1)),
    });
    await db.insert(callCampaignStations).values(c.stations.map((key) => ({ campaignId: id, stationId: stationId[key], createdAt })));
  }
  count(ctx, "AI calling campaigns", CAMPAIGNS.length);

  // ----------------------------------------------------------------- plans
  const codes = new Set<string>();
  const bookingCode = () => {
    let code = newBookingCode(4, rand.next);
    while (codes.has(code)) code = newBookingCode(4, rand.next);
    codes.add(code);
    return code;
  };

  const plans: LeadPlan[] = [];
  let next = 0;
  for (const c of CAMPAIGNS) {
    for (const [target, n] of MIX[c.key]) {
      for (let i = 0; i < n; i++) plans.push(planLead(c, target, chosen[next++]!));
    }
  }

  function planLead(c: CampaignDef, target: Target, person: DemoPerson): LeadPlan {
    const uk = person.phone!.startsWith("+44");
    const station: StationKey = c.stations.includes(uk ? "uk" : "us") ? (uk ? "uk" : "us") : c.stations[0]!;
    const [maxDays, minDays] = ENROLLED[target];
    const enrolledAt = target === "queued" || target === "reaching_today"
      ? new Date(now.getTime() - rand.int(target === "queued" ? 20 : 200, target === "queued" ? 90 : 420) * MINUTE)
      : dayAt(rand.int(minDays, maxDays), station);
    const plan: LeadPlan = {
      id: randomUUID(), campaign: c, campaignId: campaignId[c.key], person, target, enrolledAt, station: null,
      calls: [], messages: [], reply: null, status: "queued", step: 0, nextAt: null, callbacks: 0, note: null,
      bookedAt: null, meetingAt: null, bookingCode: null, followUpAt: null, stage: "to_call",
      instructions: null, crmStage: null,
    };
    if (target === "draft") return plan;
    if (target === "queued") {
      plan.nextAt = new Date(now.getTime() + rand.int(10, 140) * MINUTE);
      return plan;
    }

    const vars = { firstName: person.firstName, company: person.company.name, agentName: c.agentName };
    const placeCall = (stepKey: string | null, at: Date, result: AiCallResult, script: Script | null = null, extra: Partial<PlannedCall> = {}) => {
      const call: PlannedCall = { id: randomUUID(), stepKey, at, result, station, direction: "outbound", remoteRep: false, script, when: null, whenAt: null, ...extra };
      plan.calls.push(call);
      plan.station = station;
      return call;
    };
    const sendMessage = (stepKey: string, at: Date, body: string) => {
      plan.messages.push({ id: randomUUID(), stepKey, at, body: fill(body, { ...vars, bookingLink: plan.bookingCode ? bookingLinkFor(c.bookingUrl ?? "", plan.bookingCode) ?? "" : "" }), station, read: rand.chance(0.8) });
      plan.station = station;
    };

    // Where the conversation happens: the step index of a call step, or none.
    const callSteps = c.steps.map((s, i) => (s.kind === "call" ? i : -1)).filter((i) => i >= 0);
    const conversational: Target[] = ["booked", "booked_past", "chasing", "chasing_due", "handoff", "handoff_rep", "callback", "not_interested", "stopped"];
    const convStep = target === "callback"
      ? callSteps[0]!
      : conversational.includes(target)
        ? rand.weighted(callSteps.map((i, k) => [i, k === 0 ? 5 : k === 1 ? 3 : 1] as const))
        : -1;
    const messageStep = c.steps.findIndex((s) => s.kind === "message");
    const lastStep = target === "replied" || target === "booked_inbound" ? messageStep : target === "failed" ? 0 : c.steps.length - 1;

    let t = enrolledAt;
    let stepIndex = 0;
    let conversationAt: Date | null = null;
    let prev = enrolledAt.getTime() - MINUTE;
    for (; stepIndex < c.steps.length; stepIndex++) {
      const step = c.steps[stepIndex]!;
      if (stepIndex > 0) t = inHours(new Date(t.getTime() + step.delayHours * HOUR + rand.int(1, 25) * MINUTE), station);
      const open = target === "reaching" || target === "reaching_today";
      if (t.getTime() > now.getTime() - 5 * MINUTE) {
        // Out of time before the story ends: squeeze what is left into the last hour or so, in order.
        if (!open) t = new Date(Math.min(now.getTime() - 2 * MINUTE, Math.max(prev + 10 * MINUTE, now.getTime() - rand.int(20, 90) * MINUTE)));
        else break;
      }
      prev = t.getTime();
      const key = `reach:${step.id}`;
      if (step.kind === "message") {
        sendMessage(key, t, step.body);
      } else if (target === "failed") {
        placeCall(key, t, "not_on_whatsapp");
      } else if (stepIndex === convStep) {
        conversationAt = t;
        break;
      } else {
        placeCall(key, t, "no_answer");
      }
      if (stepIndex >= lastStep) {
        stepIndex++;
        break;
      }
    }

    const nextOpenStep = () => {
      const nextStep = c.steps[stepIndex];
      plan.status = "reaching";
      plan.step = stepIndex;
      plan.nextAt = nextStep ? (t.getTime() > now.getTime() ? t : inHours(new Date(now.getTime() + rand.int(30, 300) * MINUTE), station)) : null;
    };

    switch (target) {
      case "reaching":
      case "reaching_today": {
        if (target === "reaching_today" && !plan.calls.length) placeCall(`reach:${c.steps[0]!.id}`, new Date(now.getTime() - rand.int(10, 120) * MINUTE), "no_answer");
        if (stepIndex === 0) stepIndex = 1;
        if (stepIndex >= c.steps.length) {
          // Every step ran before now: the last one is still to come instead.
          stepIndex = c.steps.length - 1;
          const key = `reach:${c.steps[stepIndex]!.id}`;
          plan.calls = plan.calls.filter((call) => call.stepKey !== key);
          plan.messages = plan.messages.filter((m) => m.stepKey !== key);
          t = inHours(new Date(now.getTime() + rand.int(30, 600) * MINUTE), station);
        }
        nextOpenStep();
        return finish(plan);
      }
      case "unreached":
        plan.status = "unreached";
        plan.step = c.steps.length;
        plan.note = `No answer after ${plan.calls.length} calls and ${plan.messages.length === 1 ? "a message" : `${plan.messages.length} messages`}`;
        return finish(plan);
      case "failed":
        plan.status = "failed";
        plan.note = "Not on WhatsApp";
        plan.step = 0;
        return finish(plan);
      case "replied": {
        const last = plan.messages.at(-1)!;
        const reply = REPLIES[plans.filter((p) => p.target === "replied").length % REPLIES.length]!;
        plan.reply = { at: new Date(Math.min(now.getTime() - rand.int(30, 240) * MINUTE, last.at.getTime() + rand.int(40, 600) * MINUTE)), body: reply.body, intent: reply.intent, station };
        plan.status = "replied";
        plan.step = stepIndex;
        plan.note = "Replied on WhatsApp";
        plan.stage = "done";
        return finish(plan);
      }
      case "booked_inbound": {
        // No answer, then the WhatsApp, then they ring the number back.
        const message = plan.messages.at(-1) ?? null;
        const ringAt = inHours(new Date((message ?? plan.calls.at(-1)!).at.getTime() + rand.int(30, 180) * MINUTE), station);
        const meeting = futureAt(ringAt, rand.int(2, 4), rand.pick([14, 15, 16, 18]));
        placeCall(`inbound:pending`, ringAt, "conversation", INBOUND_MEETING, { direction: "inbound", when: whenText(ringAt, meeting), whenAt: meeting });
        plan.calls.at(-1)!.stepKey = `inbound:${plan.calls.at(-1)!.id}`;
        return booked(plan, ringAt, meeting, false);
      }
      default:
        break;
    }

    // A conversation: the agent's outcome decides.
    const at = conversationAt ?? new Date(now.getTime() - rand.int(30, 200) * MINUTE);
    const key = `reach:${c.steps[convStep]!.id}`;
    switch (target) {
      case "booked":
      case "booked_past":
      case "chasing":
      case "chasing_due": {
        const meeting = futureAt(at, rand.int(2, 5), rand.pick([14, 15, 16, 18, 19]));
        placeCall(key, at, "conversation", rand.pick(MEETING), { when: whenText(at, meeting), whenAt: meeting });
        if (target === "booked" || target === "booked_past") return booked(plan, at, meeting, target === "booked_past");
        return chasing(plan, at, target === "chasing_due");
      }
      case "handoff":
      case "handoff_rep": {
        const whenAt = futureAt(at, rand.int(1, 3), rand.pick([14, 15, 17, 18]));
        const script = c.goal === "human_callback" ? rand.pick(HANDOFF_TRIALS) : HANDOFF_C1;
        placeCall(key, at, "conversation", script, { when: whenText(at, whenAt), whenAt });
        plan.status = "handoff";
        plan.step = stepIndex;
        plan.note = c.goal === "human_callback" ? "Interested: wants to talk to the team" : "Wants a call from the team";
        if (target === "handoff_rep" && whenAt.getTime() < now.getTime() - HOUR) {
          // Jordan rang them back from the number ("Call now"), talking from his own tab.
          placeCall(null, inHours(new Date(whenAt.getTime() + rand.int(0, 40) * MINUTE), station), "conversation", REMOTE_REP, { remoteRep: true });
          plan.note = "Jordan called back from the number; demo to be booked with their RevOps lead";
          plan.stage = "done";
          plan.crmStage = "Demo Request";
          return finish(plan);
        }
        plan.followUpAt = whenAt;
        plan.stage = "follow_up";
        plan.crmStage = c.goal === "human_callback" ? "Trial Requested" : "Meeting Requested";
        return finish(plan);
      }
      case "callback": {
        const whenAt = futureAt(at, rand.int(1, 2), rand.pick([14, 15, 16, 18]));
        const callAt = whenAt.getTime() > now.getTime() ? at : new Date(now.getTime() - rand.int(60, 240) * MINUTE);
        const realWhen = whenAt.getTime() > now.getTime() ? whenAt : futureAt(now, 1, 15);
        placeCall(key, callAt, "conversation", rand.pick(CALL_BACK), { when: whenText(callAt, realWhen), whenAt: realWhen });
        plan.status = "callback";
        plan.step = stepIndex;
        plan.nextAt = realWhen;
        plan.callbacks = 1;
        plan.note = `Call back: ${whenText(callAt, realWhen)}`;
        return finish(plan);
      }
      case "not_interested": {
        const script = rand.pick(NOT_INTERESTED);
        placeCall(key, at, "conversation", script);
        plan.status = "not_interested";
        plan.step = stepIndex;
        plan.note = script.outcomeSummary;
        plan.stage = "done";
        plan.crmStage = script === NOT_INTERESTED[1] ? "Already Using a Tool — Not Required" : "Not Required Right Now";
        return finish(plan);
      }
      case "stopped":
        placeCall(key, at, "conversation", DO_NOT_CONTACT);
        plan.status = "stopped";
        plan.step = stepIndex;
        plan.note = "Asked not to be contacted";
        plan.stage = "done";
        plan.crmStage = DO_NOT_CONTACT_SUBCATEGORY_KEY;
        return finish(plan);
      default:
        throw new Error(`AI calling: unplanned target ${target}`);
    }
  }

  function booked(plan: LeadPlan, at: Date, meeting: Date, past: boolean): LeadPlan {
    const c = plan.campaign;
    plan.bookingCode = bookingCode();
    const linkAt = new Date(at.getTime() + rand.int(3, 6) * MINUTE);
    const body = c.bookingMessage ?? "Hi {{firstName}}, here's the link: {{bookingLink}}";
    plan.messages.push({
      id: randomUUID(), stepKey: BOOKING_LINK_KEY, at: linkAt, station: plan.station ?? c.stations[0]!, read: true,
      body: fill(body, { firstName: plan.person.firstName, company: plan.person.company.name, agentName: c.agentName, bookingLink: bookingLinkFor(c.bookingUrl!, plan.bookingCode)! }),
    });
    plan.bookedAt = new Date(Math.min(now.getTime() - 10 * MINUTE, linkAt.getTime() + rand.int(12, 600) * MINUTE));
    plan.meetingAt = past ? meeting : meeting.getTime() > now.getTime() ? meeting : futureAt(now, rand.int(1, 6), rand.pick([14, 15, 16, 18]));
    plan.status = "booked";
    plan.step = 0;
    plan.note = "Meeting booked";
    plan.crmStage = "Meeting Requested";
    if (past) {
      plan.stage = "done";
    } else {
      plan.followUpAt = new Date(Math.max(plan.bookedAt.getTime(), plan.meetingAt.getTime() - DAY));
      plan.stage = "follow_up";
    }
    return finish(plan);
  }

  function chasing(plan: LeadPlan, at: Date, due: boolean): LeadPlan {
    const c = plan.campaign;
    plan.bookingCode = bookingCode();
    const linkAt = due ? new Date(at.getTime() + rand.int(3, 6) * MINUTE) : new Date(Math.min(at.getTime() + 4 * MINUTE, now.getTime() - rand.int(60, 600) * MINUTE));
    if (!due && plan.calls.at(-1)) plan.calls.at(-1)!.at = new Date(linkAt.getTime() - 4 * MINUTE);
    const link = bookingLinkFor(c.bookingUrl!, plan.bookingCode)!;
    const vars = { firstName: plan.person.firstName, company: plan.person.company.name, agentName: c.agentName, bookingLink: link };
    const station = plan.station ?? c.stations[0]!;
    plan.messages.push({ id: randomUUID(), stepKey: BOOKING_LINK_KEY, at: linkAt, station, read: true, body: fill(c.bookingMessage ?? "{{bookingLink}}", vars) });
    plan.status = "chasing";
    plan.followUpAt = new Date(linkAt.getTime() + BOOKING_REVIEW_MS);
    plan.stage = "follow_up";
    plan.note = "Booking link sent";
    plan.crmStage = "Meeting Requested";
    const first = c.chaseSteps[0];
    const firstAt = first ? inHours(new Date(linkAt.getTime() + first.delayHours * HOUR), station) : null;
    if (first && firstAt && first.kind === "message" && firstAt.getTime() < now.getTime()) {
      plan.messages.push({ id: randomUUID(), stepKey: `chase:${first.id}`, at: firstAt, station, read: rand.chance(0.6), body: fill(first.body, vars) });
      const second = c.chaseSteps[1];
      plan.step = 1;
      plan.nextAt = second ? inHours(new Date(Math.max(firstAt.getTime() + second.delayHours * HOUR, now.getTime() + HOUR)), station) : null;
    } else {
      plan.step = 0;
      plan.nextAt = firstAt;
    }
    return finish(plan);
  }

  function finish(plan: LeadPlan): LeadPlan {
    if (plan.target === "callback" && plans.filter((p) => p.target === "callback").length === 0) {
      plan.instructions = `Ask for ${plan.person.firstName} by name; reception answers the main line. They prefer calls after 3pm.`;
    }
    return plan;
  }

  // ----------------------------------------------------------------- write: leads
  const lastCall = (plan: LeadPlan) => [...plan.calls].sort((a, b) => a.at.getTime() - b.at.getTime()).at(-1) ?? null;
  const callStatusOf = (call: PlannedCall | null): ContactCallStatus =>
    !call ? "new" : call.result === "conversation" ? "connected" : call.result === "not_on_whatsapp" ? "not_on_whatsapp" : "no_answer";

  await db.insert(callCampaignContacts).values(
    plans.map((plan) => {
      const last = lastCall(plan);
      let unanswered = 0;
      for (const call of [...plan.calls].reverse()) {
        if (call.result !== "no_answer") break;
        unanswered++;
      }
      const updatedAt = new Date(Math.max(plan.enrolledAt.getTime(), ...plan.calls.map((c) => c.at.getTime() + 2 * MINUTE), ...plan.messages.map((m) => m.at.getTime()), plan.reply?.at.getTime() ?? 0, plan.bookedAt?.getTime() ?? 0));
      return {
        id: plan.id,
        campaignId: plan.campaignId,
        personId: plan.person.id,
        stage: plan.stage,
        callStatus: callStatusOf(last),
        statusUpdatedAt: last ? new Date(last.at.getTime() + 2 * MINUTE) : null,
        unansweredAttempts: unanswered,
        followUpAt: plan.followUpAt,
        callCount: plan.calls.length,
        lastCalledAt: last?.at ?? null,
        aiStatus: plan.status,
        aiStep: plan.step,
        aiNextAt: plan.nextAt,
        aiStationId: plan.station ? stationId[plan.station] : null,
        aiCallbacks: plan.callbacks,
        aiNote: plan.note,
        aiBookedAt: plan.bookedAt,
        aiMeetingAt: plan.meetingAt,
        aiBookingCode: plan.bookingCode,
        aiInstructions: plan.instructions,
        createdAt: plan.enrolledAt,
        updatedAt,
      };
    }),
  );
  count(ctx, "AI campaign leads", plans.length);

  // ----------------------------------------------------------------- write: calls
  const sessionRows: (typeof callSessions.$inferInsert)[] = [];
  for (const plan of plans) {
    const c = plan.campaign;
    for (const call of plan.calls) {
      const v = {
        agent: call.remoteRep ? "Jordan" : c.agentName,
        lead: plan.person.firstName,
        company: plan.person.company.name,
        industry: plan.person.company.industry,
        when: call.when ?? "",
      };
      const ringMs = rand.int(6, 22) * 1000;
      const base = {
        organizationId: org,
        id: call.id,
        personId: plan.person.id,
        campaignContactId: plan.id,
        phone: plan.person.phone!,
        uploadTokenHash: sha256(randomBytes(16).toString("hex")),
        tokenExpiresAt: new Date(call.at.getTime() + 12 * HOUR),
        mode: "agent_cloud" as const,
        stationId: stationId[call.station],
        agentName: call.remoteRep ? null : c.agentName,
        agentVoice: call.remoteRep ? null : c.agentVoice,
        agentBrief: call.remoteRep ? null : `${c.instructions}\n\nThis call: ${(c.steps.find((s) => `reach:${s.id}` === call.stepKey) as { instructions?: string } | undefined)?.instructions ?? "They called us back."}\n\nLead: ${plan.person.fullName}, ${plan.person.title} at ${plan.person.company.name}.`,
        claimedAt: new Date(call.at.getTime() - rand.int(2, 8) * 1000),
        claimedBy: "demo-worker-1",
        direction: call.direction,
        remoteRep: call.remoteRep ? {} : null,
        createdAt: new Date(call.at.getTime() - rand.int(5, 20) * 1000),
      };
      if (call.result === "conversation" && call.script) {
        const lines = call.script.lines.map(([speaker, text]) => [speaker, fill(text, v)] as const);
        const offset = ringMs / 1000;
        const { utterances, talkSeconds } = timeLines(lines, offset);
        const startedAt = new Date(call.at.getTime() + ringMs);
        const endedAt = new Date(startedAt.getTime() + talkSeconds * 1000);
        const outcome: AgentOutcome | null = call.remoteRep
          ? null
          : {
              outcome: call.script.outcome,
              summary: fill(call.script.outcomeSummary, v),
              when: call.when,
              whenAt: call.whenAt?.toISOString() ?? null,
              recordedAt: new Date(endedAt.getTime() - 4000).toISOString(),
            };
        sessionRows.push({
          ...base,
          status: "recorded",
          startedAt,
          endedAt,
          durationMs: Math.round(talkSeconds * 1000),
          recordingKey: `calls/${call.at.getUTCFullYear()}/${String(call.at.getUTCMonth() + 1).padStart(2, "0")}/${call.id}.webm`,
          recordingBytes: Math.round((talkSeconds + offset) * 16_000),
          recordingContentType: "audio/webm",
          recordingOffsetMs: ringMs,
          transcriptStatus: "done",
          transcript: { language: "en", summary: fill(call.script.summary, v), utterances, model: "google/gemini-2.5-flash" },
          transcribedAt: new Date(endedAt.getTime() + rand.int(50, 110) * 1000),
          agentOutcome: outcome,
          updatedAt: new Date(endedAt.getTime() + 2 * MINUTE),
        });
      } else if (call.result === "not_on_whatsapp") {
        sessionRows.push({ ...base, status: "failed", error: "This number isn't on WhatsApp", endedAt: new Date(call.at.getTime() + 9000), updatedAt: new Date(call.at.getTime() + 9000) });
      } else {
        sessionRows.push({ ...base, status: "no_recording", startedAt: null, endedAt: new Date(call.at.getTime() + rand.int(35, 55) * 1000), updatedAt: new Date(call.at.getTime() + MINUTE) });
      }
    }
  }
  for (let i = 0; i < sessionRows.length; i += 100) await db.insert(callSessions).values(sessionRows.slice(i, i + 100));
  count(ctx, "AI agent calls", sessionRows.length);
  count(ctx, "AI agent calls connected (transcribed)", sessionRows.filter((r) => r.status === "recorded").length);

  // ----------------------------------------------------------------- write: WhatsApp from the numbers
  let n = 0;
  let replyCount = 0;
  const marker = async () => (await db.execute<{ t: string }>(sql`select clock_timestamp()::text as t`))[0]!.t;
  const restamp = async (personId: string, since: string, at: Date) => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.execute(sql`
        with v as (
          select id, row_number() over (order by created_at, id) as rn from crm_events
           where organization_id = ${org} and person_id = ${personId}::uuid and created_at > ${since}::timestamptz)
        update crm_events e set created_at = ${at.toISOString()}::timestamptz + (v.rn - 1) * interval '1 second'
          from v where e.id = v.id`);
    });
  };

  for (const plan of plans) {
    if (!plan.messages.length && !plan.reply) continue;
    const station = plan.station!;
    const phone = plan.person.phone!;
    const msgs = [...plan.messages].sort((a, b) => a.at.getTime() - b.at.getTime());
    const all = [...msgs.map((m) => ({ at: m.at, body: m.body, dir: "outbound" as const })), ...(plan.reply ? [{ at: plan.reply.at, body: plan.reply.body, dir: "inbound" as const }] : [])];
    const last = all.reduce((a, b) => (b.at > a.at ? b : a));
    const unipileChatId = `station-chat-${digitsOf(phone)}`;
    const [chat] = await db
      .insert(whatsappChats)
      .values({
        accountId: accountId[station],
        unipileChatId,
        providerId: `${digitsOf(phone)}@s.whatsapp.net`,
        phone,
        personId: plan.person.id,
        name: plan.person.fullName,
        lastMessageAt: last.at,
        lastMessagePreview: preview(last.body),
        lastDirection: last.dir,
        unreadCount: plan.reply && plan.reply.at.getTime() > now.getTime() - 2 * DAY ? 1 : 0,
        createdAt: all[0]!.at,
        updatedAt: last.at,
      })
      .returning({ id: whatsappChats.id });
    for (const m of msgs) {
      const [row] = await db
        .insert(whatsappMessages)
        .values({
          id: m.id,
          chatId: chat!.id,
          unipileMessageId: `demo-station-${String(++n).padStart(4, "0")}`,
          direction: "outbound",
          origin: "agentsdr",
          body: m.body,
          sentAt: m.at,
          deliveredAt: new Date(m.at.getTime() + rand.int(1, 9) * 1000),
          readAt: m.read ? new Date(m.at.getTime() + rand.int(3, 400) * MINUTE) : null,
          createdAt: new Date(m.at.getTime() - 30_000),
        })
        .returning({ id: whatsappMessages.id });
      await db.insert(stationMessageJobs).values({
        organizationId: org,
        stationId: stationId[m.station],
        whatsappMessageId: row!.id,
        phone,
        body: m.body,
        status: "sent",
        claimedBy: "demo-worker-1",
        claimedAt: new Date(m.at.getTime() - rand.int(5, 20) * 1000),
        sentAt: m.at,
        createdAt: new Date(m.at.getTime() - 30_000),
      });
    }
    if (plan.reply) {
      const unipileMessageId = `demo-station-${String(++n).padStart(4, "0")}`;
      const [row] = await db
        .insert(whatsappMessages)
        .values({ chatId: chat!.id, unipileMessageId, direction: "inbound", origin: "lead", body: plan.reply.body, sentAt: plan.reply.at, raw: { source: "demo-seed" }, createdAt: plan.reply.at })
        .returning({ id: whatsappMessages.id });
      const since = await marker();
      const { crmConversationMessageId } = await forwardWhatsappInboundToCrm({
        personId: plan.person.id,
        unipileAccountId: `station:${stationId[station]}`,
        unipileChatId,
        providerContactId: `${digitsOf(phone)}@s.whatsapp.net`,
        unipileMessageId,
        body: plan.reply.body,
        sentAt: plan.reply.at,
        raw: { source: "demo-seed" },
      });
      if (crmConversationMessageId) {
        await db.update(whatsappMessages).set({ crmConversationMessageId }).where(eq(whatsappMessages.id, row!.id));
        await restamp(plan.person.id, since, plan.reply.at);
        const [found] = await db.execute<{ conversation_id: string; crm_record_id: string }>(sql`
          select m.conversation_id, c.crm_record_id from crm_conversation_messages m join crm_conversations c on c.id = m.conversation_id where m.id = ${crmConversationMessageId}`);
        if (found) {
          ctx.replies.push({
            recordId: found.crm_record_id,
            personId: plan.person.id,
            conversationId: found.conversation_id,
            messageId: crmConversationMessageId,
            channel: "whatsapp",
            intent: plan.reply.intent,
            sentAt: plan.reply.at,
            rep: "jordan",
          });
          replyCount++;
        }
      }
    }
  }
  count(ctx, "AI campaign WhatsApp messages", plans.reduce((s, p) => s + p.messages.length, 0));
  count(ctx, "AI campaign WhatsApp replies to the CRM", replyCount);

  // ----------------------------------------------------------------- write: step runs
  const runRows: (typeof callCampaignStepRuns.$inferInsert)[] = [];
  for (const plan of plans) {
    for (const call of plan.calls) {
      if (!call.stepKey) continue;
      const session = sessionRows.find((r) => r.id === call.id)!;
      runRows.push({
        contactId: plan.id,
        stepKey: call.stepKey,
        kind: "call",
        status: "done",
        stationId: stationId[call.station],
        callSessionId: call.id,
        result: call.result,
        createdAt: new Date(call.at.getTime() - 20_000),
        finishedAt: new Date((session.endedAt ?? call.at).getTime() + rand.int(20, 80) * 1000),
      });
    }
    for (const m of plan.messages) {
      runRows.push({
        contactId: plan.id,
        stepKey: m.stepKey,
        kind: "message",
        status: "done",
        stationId: stationId[m.station],
        whatsappMessageId: m.id,
        createdAt: new Date(m.at.getTime() - 40_000),
        finishedAt: new Date(m.at.getTime() + rand.int(5, 30) * 1000),
      });
    }
  }
  for (let i = 0; i < runRows.length; i += 200) await db.insert(callCampaignStepRuns).values(runRows.slice(i, i + 200));

  // Each number's last call.
  for (const s of STATIONS) {
    const times = plans.flatMap((p) => p.calls.filter((c) => c.station === s.key).map((c) => c.at.getTime()));
    if (times.length) await db.update(callingStations).set({ lastCallAt: new Date(Math.max(...times)), updatedAt: new Date(Math.max(...times)) }).where(eq(callingStations.id, stationId[s.key]));
  }

  // ----------------------------------------------------------------- CRM
  const subs = await db
    .select({ id: crmSubcategories.id, name: crmSubcategories.name, key: crmSubcategories.key, categoryKey: crmSubcategories.categoryKey })
    .from(crmSubcategories)
    .where(eq(crmSubcategories.pipelineId, ctx.pipelineId));
  const subFor = (name: string) => subs.find((s) => s.name === name || s.key === name) ?? null;
  let staged = 0;
  for (const plan of plans) {
    if (!plan.crmStage) continue;
    const sub = subFor(plan.crmStage);
    if (!sub || !["interested", "customer", "not_interested", "other"].includes(sub.categoryKey)) continue;
    const at = plan.calls.filter((c) => c.result === "conversation").at(-1)?.at ?? plan.enrolledAt;
    const since = await marker();
    try {
      await setLeadStage(plan.id, { categoryKey: sub.categoryKey as "interested", subcategoryId: sub.id });
      if (plan.followUpAt) await syncCallFollowUp(plan.person.id);
      await restamp(plan.person.id, since, new Date(at.getTime() + 3 * MINUTE));
      staged++;
    } catch (error) {
      console.error(`    could not set the CRM stage for AI lead ${plan.person.fullName}:`, error instanceof Error ? error.message : error);
    }
  }
  count(ctx, "AI campaign leads in the CRM", staged);

  // Sessions point at their lead's CRM record; records made here carry the calls' history.
  const ids = plans.filter((p) => p.crmStage).map((p) => p.person.id);
  await db.execute(sql`
    update call_sessions s set crm_record_id = r.id
      from crm_records r
     where s.organization_id = ${org} and r.organization_id = ${org}
       and r.person_id = s.person_id and s.crm_record_id is null`);
  if (ids.length) {
    await db.execute(sql`
      update crm_records r
         set created_at = least(r.created_at, h.first_at), last_interaction_at = greatest(coalesce(r.last_interaction_at, h.last_at), h.last_at)
        from (select person_id, min(created_at) as first_at, max(coalesce(ended_at, created_at)) as last_at
                from call_sessions where organization_id = ${org} and mode = 'agent_cloud' group by person_id) h
       where r.organization_id = ${org} and r.person_id = h.person_id
         and r.person_id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  // The delivery ledger entries the bridge wrote carry the message's own time.
  await db.execute(sql`
    update crm_webhook_events e set created_at = m.sent_at + interval '2 seconds'
      from whatsapp_messages m
     where e.organization_id = ${org} and e.source = 'whatsapp'
       and e.payload->>'unipileMessageId' = m.unipile_message_id`);
  await db.execute(sql`
    update whatsapp_chats c set updated_at = coalesce(c.last_message_at, c.created_at)
      from whatsapp_accounts a where a.id = c.account_id and a.organization_id = ${org} and a.provider = 'station'`);

  const mix: Record<string, number> = {};
  for (const plan of plans) mix[plan.status] = (mix[plan.status] ?? 0) + 1;
  console.log(`\n    AI lead statuses: ${JSON.stringify(mix)}`);
}
