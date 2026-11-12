/**
 * The fictional world of the demo: the seller (Northwind), its team, the
 * companies and people it prospects, and the words everyone writes.
 *
 * The seller (Northwind), its team and every person are invented. The
 * companies they prospect are real, well-known ones, so lead lists show real
 * logos; the people at them and everything they "say" are fictional. Phone
 * numbers sit in the 555-0100…0199 block reserved for fiction.
 */

export const ORG_NAME = "Northwind";
export const ORG_SLUG = "northwind-demo";
export const SELLER_DOMAIN = "northwind.example";
export const PRODUCT = "Northwind Signal";

export type TeamKey = "alex" | "priya" | "jordan" | "sam" | "lena";

/** The seller's team. Alex is the demo user every visitor is signed in as. */
export const TEAM: Record<TeamKey, { name: string; first: string; email: string; title: string; role: "owner" | "admin" | "member"; phone: string; avatar: string }> = {
  alex: { name: "Alex Morgan", first: "Alex", email: "demo@example.com", title: "Head of Sales", role: "owner", phone: "+12025550101", avatar: "https://randomuser.me/api/portraits/men/32.jpg" },
  priya: { name: "Priya Raman", first: "Priya", email: "priya@northwind.example", title: "SDR Team Lead", role: "admin", phone: "+12025550102", avatar: "https://randomuser.me/api/portraits/women/44.jpg" },
  jordan: { name: "Jordan Blake", first: "Jordan", email: "jordan@northwind.example", title: "Account Executive", role: "member", phone: "+12025550103", avatar: "https://randomuser.me/api/portraits/men/46.jpg" },
  sam: { name: "Sam Okafor", first: "Sam", email: "sam@northwind.example", title: "Sales Development Rep", role: "member", phone: "+12025550104", avatar: "https://randomuser.me/api/portraits/men/75.jpg" },
  lena: { name: "Lena Fischer", first: "Lena", email: "lena@northwind.example", title: "Sales Development Rep", role: "member", phone: "+12025550105", avatar: "https://randomuser.me/api/portraits/women/65.jpg" },
};

/** Sending addresses (one per rep, plus a shared one). Alex's sends as alex@, not the demo login. */
export const MAILBOXES: { email: string; name: string; owner: TeamKey; dailyLimit: number }[] = [
  { email: "alex@northwind.example", name: "Alex Morgan", owner: "alex", dailyLimit: 40 },
  { email: "priya@northwind.example", name: "Priya Raman", owner: "priya", dailyLimit: 50 },
  { email: "jordan@northwind.example", name: "Jordan Blake", owner: "jordan", dailyLimit: 40 },
  { email: "sam@trynorthwind.example", name: "Sam Okafor", owner: "sam", dailyLimit: 50 },
  { email: "lena@trynorthwind.example", name: "Lena Fischer", owner: "lena", dailyLimit: 50 },
  { email: "hello@trynorthwind.example", name: "Northwind Team", owner: "priya", dailyLimit: 30 },
];

export type Industry =
  | "B2B SaaS" | "Fintech" | "Healthtech" | "Logistics" | "E-commerce" | "Cybersecurity" | "Developer tools"
  | "HR tech" | "Martech" | "Edtech" | "Proptech" | "Climate tech" | "Manufacturing" | "Agency" | "Insurtech" | "Legal tech";

export type CompanySeed = {
  name: string;
  slug: string;
  /** The real website domain: its favicon is the logo the app shows. */
  domain: string;
  industry: Industry;
  employees: number;
  hq: string;
  country: "US" | "UK" | "DE" | "NL" | "FR" | "SE" | "IN" | "CA" | "AU" | "SG" | "ES" | "IE";
  funding: "Bootstrapped" | "Seed" | "Series A" | "Series B" | "Series C" | "Private" | "Public" | "PE-backed";
  founded: number;
  blurb: string;
};

/**
 * [name, domain, industry, employees, hq, country, funding, founded, one-line description].
 * Real, well-known companies, so the lead lists show their real logos (the
 * app fetches each domain's favicon). Headcounts and details are rough public
 * figures; the people at them and everything they "say" are invented.
 */
const COMPANY_ROWS: [string, string, Industry, number, string, CompanySeed["country"], CompanySeed["funding"], number, string][] = [
  ["Google", "google.com", "B2B SaaS", 182000, "Mountain View, CA", "US", "Public", 1998, "Search, ads, cloud and workspace software"],
  ["Microsoft", "microsoft.com", "B2B SaaS", 228000, "Redmond, WA", "US", "Public", 1975, "Cloud, productivity and developer platforms"],
  ["Amazon", "amazon.com", "E-commerce", 1500000, "Seattle, WA", "US", "Public", 1994, "Online retail and cloud infrastructure"],
  ["Salesforce", "salesforce.com", "B2B SaaS", 72000, "San Francisco, CA", "US", "Public", 1999, "CRM and customer platforms"],
  ["HubSpot", "hubspot.com", "Martech", 8000, "Cambridge, MA", "US", "Public", 2006, "CRM, marketing and sales software for growing teams"],
  ["Stripe", "stripe.com", "Fintech", 8500, "San Francisco, CA", "US", "Private", 2010, "Payments infrastructure for the internet"],
  ["Shopify", "shopify.com", "E-commerce", 8100, "Ottawa", "CA", "Public", 2006, "Commerce platform for online and retail stores"],
  ["Notion", "notion.so", "B2B SaaS", 800, "San Francisco, CA", "US", "Private", 2013, "Connected workspace for docs, wikis and projects"],
  ["Figma", "figma.com", "B2B SaaS", 1600, "San Francisco, CA", "US", "Public", 2012, "Collaborative design and prototyping"],
  ["Slack", "slack.com", "B2B SaaS", 2500, "San Francisco, CA", "US", "Public", 2009, "Messaging for work"],
  ["Zoom", "zoom.us", "B2B SaaS", 7400, "San Jose, CA", "US", "Public", 2011, "Video meetings, phone and contact center"],
  ["Atlassian", "atlassian.com", "Developer tools", 12000, "Sydney", "AU", "Public", 2002, "Team collaboration and software development tools"],
  ["Canva", "canva.com", "Martech", 5000, "Sydney", "AU", "Private", 2012, "Online design for everyone"],
  ["Datadog", "datadoghq.com", "Developer tools", 6500, "New York, NY", "US", "Public", 2010, "Monitoring and security for cloud apps"],
  ["Snowflake", "snowflake.com", "Developer tools", 7800, "Bozeman, MT", "US", "Public", 2012, "The data cloud"],
  ["MongoDB", "mongodb.com", "Developer tools", 5000, "New York, NY", "US", "Public", 2007, "Developer data platform"],
  ["Twilio", "twilio.com", "Developer tools", 5500, "San Francisco, CA", "US", "Public", 2008, "Customer engagement APIs: SMS, voice, email"],
  ["Cloudflare", "cloudflare.com", "Cybersecurity", 4000, "San Francisco, CA", "US", "Public", 2009, "Connectivity cloud: security, performance, networking"],
  ["GitLab", "gitlab.com", "Developer tools", 2100, "San Francisco, CA", "US", "Public", 2011, "DevSecOps platform"],
  ["Vercel", "vercel.com", "Developer tools", 650, "San Francisco, CA", "US", "Private", 2015, "Frontend cloud for building and deploying web apps"],
  ["Supabase", "supabase.com", "Developer tools", 150, "Singapore", "SG", "Private", 2020, "Open-source Postgres development platform"],
  ["Postman", "postman.com", "Developer tools", 800, "San Francisco, CA", "US", "Private", 2014, "API development platform"],
  ["Asana", "asana.com", "B2B SaaS", 1800, "San Francisco, CA", "US", "Public", 2008, "Work management for teams"],
  ["Monday.com", "monday.com", "B2B SaaS", 2300, "Tel Aviv / New York", "US", "Public", 2012, "Work operating system"],
  ["Airtable", "airtable.com", "B2B SaaS", 900, "San Francisco, CA", "US", "Private", 2012, "Build apps on top of shared data"],
  ["Miro", "miro.com", "B2B SaaS", 1800, "Amsterdam", "NL", "Private", 2011, "Visual collaboration workspace"],
  ["Intercom", "intercom.com", "B2B SaaS", 1000, "Dublin", "IE", "Private", 2011, "AI-first customer service platform"],
  ["Zendesk", "zendesk.com", "B2B SaaS", 6000, "San Francisco, CA", "US", "PE-backed", 2007, "Customer service software"],
  ["Freshworks", "freshworks.com", "B2B SaaS", 4500, "Chennai / San Mateo", "IN", "Public", 2010, "Customer and employee service software"],
  ["Calendly", "calendly.com", "B2B SaaS", 600, "Atlanta, GA", "US", "Series B", 2013, "Scheduling automation"],
  ["Dropbox", "dropbox.com", "B2B SaaS", 2700, "San Francisco, CA", "US", "Public", 2007, "File storage, sharing and e-signature"],
  ["Zapier", "zapier.com", "B2B SaaS", 800, "San Francisco, CA", "US", "Bootstrapped", 2011, "No-code automation across apps"],
  ["Webflow", "webflow.com", "Martech", 700, "San Francisco, CA", "US", "Private", 2013, "Visual web development platform"],
  ["Mailchimp", "mailchimp.com", "Martech", 1200, "Atlanta, GA", "US", "Public", 2001, "Email marketing and automation"],
  ["Semrush", "semrush.com", "Martech", 1500, "Boston, MA", "US", "Public", 2008, "Online visibility and SEO platform"],
  ["Hootsuite", "hootsuite.com", "Martech", 1000, "Vancouver", "CA", "Private", 2008, "Social media management"],
  ["Okta", "okta.com", "Cybersecurity", 5900, "San Francisco, CA", "US", "Public", 2009, "Identity for workforce and customers"],
  ["CrowdStrike", "crowdstrike.com", "Cybersecurity", 9000, "Austin, TX", "US", "Public", 2011, "Endpoint and cloud security"],
  ["Palo Alto Networks", "paloaltonetworks.com", "Cybersecurity", 15000, "Santa Clara, CA", "US", "Public", 2005, "Network and cloud security"],
  ["1Password", "1password.com", "Cybersecurity", 1200, "Toronto", "CA", "Private", 2005, "Password and identity security"],
  ["Zscaler", "zscaler.com", "Cybersecurity", 7300, "San Jose, CA", "US", "Public", 2007, "Zero-trust cloud security"],
  ["Plaid", "plaid.com", "Fintech", 1200, "San Francisco, CA", "US", "Private", 2013, "Financial data network"],
  ["Brex", "brex.com", "Fintech", 1100, "San Francisco, CA", "US", "Private", 2017, "Corporate cards and spend management"],
  ["Ramp", "ramp.com", "Fintech", 1000, "New York, NY", "US", "Private", 2019, "Finance automation and corporate cards"],
  ["Revolut", "revolut.com", "Fintech", 10000, "London", "UK", "Private", 2015, "Global financial super-app"],
  ["Wise", "wise.com", "Fintech", 6000, "London", "UK", "Public", 2011, "International money transfers"],
  ["Klarna", "klarna.com", "Fintech", 3500, "Stockholm", "SE", "Public", 2005, "Payments and shopping"],
  ["Adyen", "adyen.com", "Fintech", 4300, "Amsterdam", "NL", "Public", 2006, "Global payments platform"],
  ["Coinbase", "coinbase.com", "Fintech", 3700, "San Francisco, CA", "US", "Public", 2012, "Crypto exchange and infrastructure"],
  ["Razorpay", "razorpay.com", "Fintech", 3000, "Bengaluru", "IN", "Private", 2014, "Payments and banking for businesses"],
  ["Rippling", "rippling.com", "HR tech", 4000, "San Francisco, CA", "US", "Private", 2016, "HR, IT and finance in one place"],
  ["Gusto", "gusto.com", "HR tech", 2500, "San Francisco, CA", "US", "Private", 2011, "Payroll and HR for small businesses"],
  ["Deel", "deel.com", "HR tech", 4500, "San Francisco, CA", "US", "Private", 2019, "Global hiring and payroll"],
  ["Workday", "workday.com", "HR tech", 18000, "Pleasanton, CA", "US", "Public", 2005, "Finance and HR cloud"],
  ["Greenhouse", "greenhouse.com", "HR tech", 900, "New York, NY", "US", "PE-backed", 2012, "Hiring software"],
  ["Lattice", "lattice.com", "HR tech", 500, "San Francisco, CA", "US", "Private", 2015, "People management platform"],
  ["Duolingo", "duolingo.com", "Edtech", 800, "Pittsburgh, PA", "US", "Public", 2011, "Language learning app"],
  ["Coursera", "coursera.org", "Edtech", 1300, "Mountain View, CA", "US", "Public", 2012, "Online courses and degrees"],
  ["Udemy", "udemy.com", "Edtech", 1400, "San Francisco, CA", "US", "Public", 2010, "Online learning marketplace"],
  ["Airbnb", "airbnb.com", "Proptech", 7000, "San Francisco, CA", "US", "Public", 2008, "Stays and experiences marketplace"],
  ["Zillow", "zillow.com", "Proptech", 6800, "Seattle, WA", "US", "Public", 2006, "Real estate marketplace"],
  ["Opendoor", "opendoor.com", "Proptech", 1500, "San Francisco, CA", "US", "Public", 2014, "Digital home buying and selling"],
  ["Uber", "uber.com", "Logistics", 31000, "San Francisco, CA", "US", "Public", 2009, "Rides, delivery and freight"],
  ["DoorDash", "doordash.com", "Logistics", 19000, "San Francisco, CA", "US", "Public", 2013, "Local delivery platform"],
  ["Flexport", "flexport.com", "Logistics", 2500, "San Francisco, CA", "US", "Private", 2013, "Global freight and supply chain platform"],
  ["Instacart", "instacart.com", "E-commerce", 3300, "San Francisco, CA", "US", "Public", 2012, "Grocery delivery and pickup"],
  ["Etsy", "etsy.com", "E-commerce", 2400, "Brooklyn, NY", "US", "Public", 2005, "Marketplace for creative goods"],
  ["Wayfair", "wayfair.com", "E-commerce", 12000, "Boston, MA", "US", "Public", 2002, "Online home goods retailer"],
  ["Zalando", "zalando.com", "E-commerce", 15000, "Berlin", "DE", "Public", 2008, "Online fashion platform"],
  ["Spotify", "spotify.com", "B2B SaaS", 7300, "Stockholm", "SE", "Public", 2006, "Audio streaming"],
  ["Tesla", "tesla.com", "Climate tech", 125000, "Austin, TX", "US", "Public", 2003, "Electric vehicles and energy storage"],
  ["Enphase Energy", "enphase.com", "Climate tech", 3100, "Fremont, CA", "US", "Public", 2006, "Solar microinverters and home energy"],
  ["Sunrun", "sunrun.com", "Climate tech", 10000, "San Francisco, CA", "US", "Public", 2007, "Residential solar and batteries"],
  ["Siemens", "siemens.com", "Manufacturing", 320000, "Munich", "DE", "Public", 1847, "Industrial automation and infrastructure"],
  ["Bosch", "bosch.com", "Manufacturing", 420000, "Gerlingen", "DE", "Private", 1886, "Engineering and technology"],
  ["Oscar Health", "hioscar.com", "Insurtech", 2400, "New York, NY", "US", "Public", 2012, "Technology-driven health insurance"],
  ["Lemonade", "lemonade.com", "Insurtech", 1300, "New York, NY", "US", "Public", 2015, "AI-powered insurance"],
  ["Doctolib", "doctolib.fr", "Healthtech", 2800, "Paris", "FR", "Private", 2013, "Medical appointments and practice software"],
  ["Zocdoc", "zocdoc.com", "Healthtech", 900, "New York, NY", "US", "Private", 2007, "Find and book doctors"],
  ["Teladoc Health", "teladochealth.com", "Healthtech", 5600, "Purchase, NY", "US", "Public", 2002, "Virtual care"],
  ["DocuSign", "docusign.com", "Legal tech", 6800, "San Francisco, CA", "US", "Public", 2003, "Electronic signature and agreements"],
  ["Clio", "clio.com", "Legal tech", 1200, "Burnaby", "CA", "Private", 2008, "Legal practice management"],
  ["Ironclad", "ironcladapp.com", "Legal tech", 600, "San Francisco, CA", "US", "Private", 2014, "Contract lifecycle management"],
  ["WPP", "wpp.com", "Agency", 110000, "London", "UK", "Public", 1985, "Creative transformation company"],
];

const slugify = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");

export const COMPANIES: CompanySeed[] = COMPANY_ROWS.map(([name, domain, industry, employees, hq, country, funding, founded, blurb]) => ({
  name,
  slug: slugify(name),
  domain,
  industry,
  employees,
  hq,
  country,
  funding,
  founded,
  blurb,
}));

export const companyDomain = (c: CompanySeed) => c.domain;

export const FEMALE_FIRST = [
  "Ava", "Noor", "Elena", "Hana", "Maya", "Ingrid", "Sana", "Leila", "Greta", "Chloe", "Zara", "Mei", "Amara", "Nia",
  "Esme", "Farah", "Alina", "Tess", "Rosa", "Sofia", "Isabel", "Aisha", "Claire", "Naomi", "Freya", "Yuki", "Lucia",
  "Imani", "Hannah", "Olivia", "Grace", "Meera", "Ananya", "Camille", "Astrid", "Daniela", "Keisha", "Rachel", "Emily",
  "Julia", "Laura", "Nadia", "Talia", "Vera", "Paloma", "Ines", "Siobhan", "Ruth", "Wen", "Kavya", "Leah", "Mira",
  "Sarah", "Zoe", "Anika", "Bianca", "Celeste", "Dana", "Erin", "Fatima",
];
export const MALE_FIRST = [
  "Liam", "Mateo", "Jonas", "Kofi", "Oscar", "Tariq", "Diego", "Felix", "Ravi", "Omar", "Anders", "Hugo", "Lucas", "Ivan",
  "Theo", "Kenji", "Bruno", "Samir", "Dmitri", "Yusuf", "Ethan", "Marcus", "Daniel", "Arjun", "Rohan", "Gabriel", "Noah",
  "Henrik", "Malik", "Tomas", "Wei", "Nikhil", "Patrick", "Rafael", "Sebastian", "Owen", "Caleb", "Elias", "Hiro", "Jamal",
  "Kai", "Leon", "Max", "Nathan", "Pablo", "Quentin", "Ryan", "Simon", "Victor", "Andre", "Ben", "Chris", "David", "Evan",
  "Finn", "George", "Isaac", "Jack", "Karim", "Luca",
];
export const LAST_NAMES = [
  "Alder", "Brennan", "Castillo", "Dunmore", "Okafor", "Lindqvist", "Marlowe", "Nakamura", "Oyelaran", "Pemberton",
  "Quade", "Rasmussen", "Sorensen", "Thackeray", "Underhill", "Valdez", "Whitlock", "Xiong", "Yilmaz", "Zielinski",
  "Abernathy", "Bhatt", "Calloway", "Delacroix", "Eriksen", "Fairbanks", "Gallagher", "Hargrove", "Iyer", "Jansen",
  "Kowalski", "Lockhart", "Mendoza", "Novak", "Osei", "Prescott", "Quintero", "Rinaldi", "Sato", "Tremblay",
  "Ueda", "Vasquez", "Wakefield", "Achebe", "Bergstrom", "Chandra", "Doyle", "Esposito", "Fontaine", "Grayson",
  "Halvorsen", "Ishikawa", "Kapoor", "Larsen", "Moreau", "Nguyen", "OConnell", "Petrov", "Reyes", "Schneider",
  "Takahashi", "Varga", "Weston", "Adeyemi", "Banerjee", "Costa", "Dimitriou", "Ellison", "Fischer", "Gupta",
  "Holloway", "Ivanova", "Kimura", "Lindgren", "Mahmoud", "Nilsen", "Okonkwo", "Park", "Rossi", "Shah",
];

/** Titles, weighted towards the people Northwind sells to. */
export const TITLES: { title: string; seniority: "C-level" | "VP" | "Director" | "Manager" | "Founder"; weight: number }[] = [
  { title: "VP of Sales", seniority: "VP", weight: 9 },
  { title: "Head of Sales", seniority: "Director", weight: 8 },
  { title: "Director of Sales Development", seniority: "Director", weight: 7 },
  { title: "Revenue Operations Manager", seniority: "Manager", weight: 7 },
  { title: "Head of Growth", seniority: "Director", weight: 6 },
  { title: "Chief Revenue Officer", seniority: "C-level", weight: 5 },
  { title: "Founder & CEO", seniority: "Founder", weight: 6 },
  { title: "Co-founder", seniority: "Founder", weight: 3 },
  { title: "SDR Manager", seniority: "Manager", weight: 6 },
  { title: "Sales Operations Lead", seniority: "Manager", weight: 5 },
  { title: "VP of Marketing", seniority: "VP", weight: 4 },
  { title: "Head of Demand Generation", seniority: "Director", weight: 4 },
  { title: "Director of Business Development", seniority: "Director", weight: 4 },
  { title: "Head of Partnerships", seniority: "Director", weight: 3 },
  { title: "Chief Operating Officer", seniority: "C-level", weight: 2 },
  { title: "VP of Revenue Operations", seniority: "VP", weight: 3 },
  { title: "Enterprise Account Director", seniority: "Director", weight: 2 },
  { title: "Growth Marketing Manager", seniority: "Manager", weight: 3 },
];

export const CITY_FOR_COUNTRY: Record<CompanySeed["country"], string[]> = {
  US: ["New York, NY", "San Francisco, CA", "Austin, TX", "Chicago, IL", "Boston, MA", "Denver, CO", "Seattle, WA", "Atlanta, GA", "Remote (US)"],
  UK: ["London", "Manchester", "Bristol", "Edinburgh"],
  DE: ["Berlin", "Munich", "Hamburg"],
  NL: ["Amsterdam", "Rotterdam", "Utrecht"],
  FR: ["Paris", "Lyon"],
  SE: ["Stockholm", "Gothenburg"],
  IN: ["Bengaluru", "Mumbai", "Pune", "Hyderabad"],
  CA: ["Toronto", "Vancouver", "Montreal"],
  AU: ["Sydney", "Melbourne"],
  SG: ["Singapore"],
  ES: ["Barcelona", "Madrid", "Lisbon"],
  IE: ["Dublin", "Cork"],
};

/**
 * What a lead writes back, by the CRM subcategory it belongs in. `long` reads
 * like an email; `short` like a LinkedIn or WhatsApp message. `{first}` is
 * the sender's rep first name, `{company}` the lead's company.
 */
export type ReplyIntent =
  | "Meeting Requested"
  | "Demo Request"
  | "Information Requested"
  | "Case Study"
  | "Trial Requested"
  | "Not Required Right Now"
  | "Already Using a Tool — Not Required"
  | "Connected to Different POC"
  | "Out of Office"
  | "Left Company"
  | "Do Not Contact"
  | "Other";

export const REPLIES: Record<ReplyIntent, { long: string[]; short: string[] }> = {
  "Meeting Requested": {
    long: [
      "Hi {first},\n\nGood timing — we just lost two SDRs and the rest of the team is drowning in research. Could we do 30 minutes next Tuesday or Wednesday afternoon?\n\nThanks,",
      "Hey {first},\n\nThis is relevant. We're rebuilding our outbound motion for Q1 and I'd like to see how you handle multi-channel sequences. Send me a couple of times that work next week.\n\nBest,",
      "{first} — happy to take a call. Thursday after 2pm ET works best on my side. Can you include our RevOps lead, Dana? I'll forward her the invite.",
      "Hi {first},\n\nYes, let's talk. I'm free Monday 11:00–12:30 or Friday morning. A short agenda would help so I can bring the right people.\n\nRegards,",
    ],
    short: [
      "Sure, happy to chat. Does Thursday afternoon work?",
      "Yes — send me a calendar link and I'll grab a slot this week.",
      "Interesting. Let's do 20 min next week, mornings are best for me.",
      "Good timing actually. Can we talk Tuesday?",
    ],
  },
  "Demo Request": {
    long: [
      "Hi {first},\n\nWe've been evaluating tools for exactly this. Could you walk me and our sales ops manager through a live demo? Ideally with LinkedIn and email in the same sequence.\n\nThanks,",
      "Hello {first},\n\nI'd like to see a demo. Specifically how replies get classified and how the drafts look before they go out — that's where we lose the most time today.\n\nCheers,",
      "{first}, can you show us the product on a call? We have 12 reps across two regions, so I'd like to understand how mailboxes and limits work per person.",
    ],
    short: [
      "Can you show me a quick demo? Mostly curious about the WhatsApp side.",
      "Would love a demo. Our team is 8 SDRs, mostly LinkedIn.",
      "Demo please — this week if possible.",
    ],
  },
  "Information Requested": {
    long: [
      "Hi {first},\n\nThanks for reaching out. Before we set up a call, could you send pricing and a short overview of how {product} connects to our CRM? We're on HubSpot.\n\nBest,",
      "Hi {first},\n\nCan you share more detail on data privacy — where our lead data is stored and who on your side can access it? Security review is usually the long pole for us.\n\nThanks,",
      "{first}, what does onboarding look like? We'd need to import roughly 40k contacts from spreadsheets. A one-pager would be great.",
      "Hi {first},\n\nInteresting. How is this different from the sequencing tool we already have? A short comparison would help me make the case internally.\n\nRegards,",
    ],
    short: [
      "Do you have pricing you can share?",
      "What does it integrate with? We use HubSpot and Slack.",
      "Can you send over a one-pager? Will share with my team.",
      "How long does setup usually take?",
    ],
  },
  "Case Study": {
    long: [
      "Hi {first},\n\nDo you have a case study from a team our size (around 15 reps)? I'd need something concrete to take to our CRO.\n\nThanks,",
      "Hey {first},\n\nCurious, but I'd want to see results from another {industry} company before committing time. Any references you can share?\n\nBest,",
    ],
    short: [
      "Any case studies from {industry} companies?",
      "Who else like us is using this? Would love an example.",
    ],
  },
  "Trial Requested": {
    long: [
      "Hi {first},\n\nRather than a call, can we just try it? Two of my reps would happily run a two-week pilot on one campaign.\n\nThanks,",
      "{first} — is there a trial? I'd like to connect one mailbox and one LinkedIn account and see how it handles our replies.",
    ],
    short: [
      "Is there a free trial? I'd rather just try it.",
      "Can we pilot it with two reps first?",
    ],
  },
  "Not Required Right Now": {
    long: [
      "Hi {first},\n\nAppreciate the note. We're mid-way through a reorg and won't look at new tools until Q2. Feel free to check back then.\n\nBest,",
      "Thanks {first} — not a priority this quarter. Budget is frozen until the new fiscal year in April.",
      "Hi {first},\n\nWe just hired a new VP of Sales who starts next month. I'd rather wait until they're settled. Reach out in 6–8 weeks?\n\nThanks,",
    ],
    short: [
      "Not right now, maybe next quarter.",
      "Bad timing, we're in a hiring freeze. Ping me in a couple of months?",
      "Thanks, but not a priority this quarter.",
    ],
  },
  "Already Using a Tool — Not Required": {
    long: [
      "Hi {first},\n\nThanks, but we signed a two-year contract with another platform last spring and the team is happy with it.\n\nBest of luck,",
      "{first}, we built something in-house for this and it does the job. Not looking to switch.",
    ],
    short: [
      "We already use another tool for this, thanks though.",
      "All set on this front — happy with what we have.",
    ],
  },
  "Connected to Different POC": {
    long: [
      "Hi {first},\n\nI'm not the right person — our Head of Sales Ops, Marcus, owns tooling decisions. I've copied him here.\n\nThanks,",
      "Thanks {first}. Forwarding to Elena on our growth team; she's been looking at exactly this.",
    ],
    short: [
      "Not my area — talk to our RevOps lead, I'll intro you.",
      "Forwarding to our head of growth, she owns this.",
    ],
  },
  "Out of Office": {
    long: [
      "Thank you for your email. I'm out of the office until Monday the 21st with limited access to email. For anything urgent please contact sales-ops@{domain}.",
      "I'm currently on parental leave and will return in early November. Your message will not be forwarded.",
      "Out of office: travelling for our sales kickoff this week. I'll reply when I'm back on Thursday.",
    ],
    short: ["On holiday until next week, will get back to you then."],
  },
  "Left Company": {
    long: [
      "Hi, thanks for your message. I've moved on from {company} — please reach out to the team at info@{domain} instead. All the best!",
    ],
    short: ["I left {company} last month, sorry! Good luck."],
  },
  "Do Not Contact": {
    long: ["Please remove me from your mailing list."],
    short: ["Please stop messaging me."],
  },
  "Other": {
    long: [
      "Hi {first}, is this an automated message? Genuinely curious how you found me.",
    ],
    short: ["Who is this?", "How did you get my number?"],
  },
};

/**
 * How often each intent shows up among replies. Mirrors a healthy outbound
 * program: most replies are positive or "not now", a few are noise.
 */
export const REPLY_MIX: [ReplyIntent, number][] = [
  ["Meeting Requested", 16],
  ["Demo Request", 9],
  ["Information Requested", 16],
  ["Case Study", 5],
  ["Trial Requested", 5],
  ["Not Required Right Now", 15],
  ["Already Using a Tool — Not Required", 8],
  ["Connected to Different POC", 6],
  ["Out of Office", 8],
  ["Left Company", 2],
  ["Do Not Contact", 2],
  ["Other", 2],
];

/** What Northwind's knowledge base says (Settings → Knowledge). */
export const KNOWLEDGE_DOCS: { title: string; kind: "company" | "product" | "pricing" | "faq" | "case_study" | "objection" | "scheduling" | "custom"; tags: string[]; alwaysInclude: boolean; content: string }[] = [
  {
    title: "About Northwind",
    kind: "company",
    tags: ["company", "positioning", "public"],
    alwaysInclude: true,
    content: `# About Northwind

Northwind is a fictional company used to show BraintreeSDR with sample data. Nothing here describes a real business.

## What we sell
${PRODUCT} is revenue intelligence for B2B sales teams of 5 to 100 reps. It pulls lead and company data together, scores accounts against your ICP, and tells reps who to contact this week and why.

## Who it is for
- Sales and RevOps leaders at B2B companies with 50–1,000 employees
- Teams that prospect by email and LinkedIn and track deals in HubSpot, Salesforce or spreadsheets

## Proof points
- Customers cut research time per account from ~25 minutes to under 5
- Median customer books 31% more first meetings in their first quarter
- SOC 2 Type II; data is isolated per customer workspace

## Tone
Plain, specific and brief. No hype words. One clear ask per message.`,
  },
  {
    title: "Pricing and packaging",
    kind: "pricing",
    tags: ["pricing"],
    alwaysInclude: true,
    content: `# Pricing

- **Starter** — 49 USD per seat per month, up to 1,000 accounts tracked.
- **Team** — 129 USD per seat per month, up to 25,000 accounts, shared inbox, CRM sync.
- **Scale** — custom pricing, SSO, audit logs, dedicated success manager.

Annual contracts get 15% off. Pilots: two seats free for 14 days, one campaign.

Never quote a discount beyond 15% in writing — route those to Alex.`,
  },
  {
    title: "Case study: Brightloop books 2.1x more meetings",
    kind: "case_study",
    tags: ["case study", "saas", "public"],
    alwaysInclude: false,
    content: `# Brightloop (B2B SaaS, 140 employees)

**Problem:** 6 SDRs spent half their week researching accounts by hand.
**What changed:** ${PRODUCT} prioritised 400 accounts a week and drafted the first touch.
**Result:** first meetings went from 38 to 81 per month within one quarter; research time down 70%.

> "My reps finally spend their time talking to people instead of tabs." — VP of Sales, Brightloop (fictional)

Brightloop has agreed to be named publicly, including in LinkedIn posts.`,
  },
  {
    title: "Handling common objections",
    kind: "objection",
    tags: ["objections", "faq"],
    alwaysInclude: false,
    content: `# Objections

**"We already use a sequencing tool."** ${PRODUCT} decides *who* and *why*; it feeds the tool you have. Most customers keep their sequencer.

**"No budget this quarter."** Offer the free two-seat pilot so the case is built before budget season.

**"Security review takes months."** Share the SOC 2 report and DPA up front; the standard review takes ~2 weeks.

**"Send me information."** Send the one-pager *and* propose two specific times — information requests convert best within 48 hours.`,
  },
];

/** The CRM's standing instructions to the drafting model (Settings → Instructions). */
export const AI_INSTRUCTIONS = `Write like a thoughtful AE, not a marketer: short paragraphs, no exclamation marks, one clear next step.
Always propose two concrete meeting times in the lead's timezone when they show interest.
Mention a relevant proof point from the knowledge base only if it matches their industry or team size.
Never promise discounts above 15%. Sign off with the rep's first name only.`;
