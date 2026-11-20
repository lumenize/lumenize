
<script>

import Radar from '$lib/components/Radar/Radar.svelte'

const radarProps = {
    identifyingData: {you: 'can put anything here to be returned on events'},
    // baseColor: "#AA0000",  // Default is Transformation.dev Blueprint green
    // goalColor: "#AA0000",
    showLogo: false,
    title: "Nueway Dynamics",
    radarSize: 150,
    // showSidebar: false,
    sidebarWidth: 70,
    showSummaryStats: false,
    // descriptionsInLegend: false,  // Default is true
    levelConfig: [
      // levelConfig[0]  is the "best" level, closest to center, and baseColor
      {_entityID: "Culture", label: "Culture", description: "We have fully adopted this practice"},
      // Other levels without a color will be a gradient of the baseColor
      {_entityID: "Actions", label: "Actions", description: "We’re in the process of adopting this practice"},
      {_entityID: "Words", label: "Words", description: "We’re making plans to adopt this practice"},
      // The last index without a color will be white
      {_entityID: "Thoughts", label: "Thoughts", description: "We do not have plans for this practice"},
      // You can specify a color for any of the levels, useful for NA or the like. Must come after baseColor-derived levels
      {_entityID: "Unknown", considerNotAssessed: true, label: "Unknown", description: "Unassessed or Needs follow up", color: "#A0C5DA"},
      // excludeFromGoal values must all be at the end
      {_entityID: "Tradeoff", excludeFromGoal: true, label: "Tradeoff", description: "This practice is not worth it in this context", color: "#CCCCCC"},
      {_entityID: "Deferral", excludeFromGoal: true, label: "Deferral", description: "Reconsider once there is an \"easy-button\" for this", color: "#666666"},
    ],
    teams: [
      {_entityID: "Team0", label: "Combustion Controls"},
      {_entityID: "Team1", label: "High Speed Manufacturing"},
      {_entityID: "Team2", label: "Web Services"},
      {_entityID: "Team3", label: "Design Services"},
      {_entityID: "Team4", label: "Bespoke Solutions"},
    ],
    assessmentData: [
      // Combustion Controls
      {teamID: "Team0", practiceID: "Container-based CI", levelID: "Deferral"},
      {teamID: "Team0", practiceID: "Working Agreements", levelID: "Words"},
      {teamID: "Team0", practiceID: "Ephemeral Test Env", levelID: "Deferral"},
      {teamID: "Team0", practiceID: "ADR + AVM", levelID: "Words"},
      {teamID: "Team0", practiceID: "DDoS", levelID: "Culture"},
      {teamID: "Team0", practiceID: "Secure Coding", levelID: "Culture"},
      {teamID: "Team0", practiceID: "Critical Clean 1st-P", levelID: "Deferral"},
      {teamID: "Team0", practiceID: "High Clean 1st-P", levelID: "Deferral"},
      {teamID: "Team0", practiceID: "Critical Clean SBoM", levelID: "Deferral"},
      {teamID: "Team0", practiceID: "High Clean SBoM", levelID: "Deferral"},
      {teamID: "Team0", practiceID: "Security Peer Review", levelID: "Thoughts"},

      // High Speed Manufacturing
      {teamID: "Team1", practiceID: "Container-based CI", levelID: "Culture"},
      {teamID: "Team1", practiceID: "Working Agreements", levelID: "Culture"},
      {teamID: "Team1", practiceID: "Ephemeral Test Env", levelID: "Actions"},
      {teamID: "Team1", practiceID: "ADR + AVM", levelID: "Words"},
      {teamID: "Team1", practiceID: "DDoS", levelID: "Words"},
      {teamID: "Team1", practiceID: "Secure Coding", levelID: "Actions"},
      {teamID: "Team1", practiceID: "Critical Clean 1st-P", levelID: "Words"},
      {teamID: "Team1", practiceID: "High Clean 1st-P", levelID: "Thoughts"},
      {teamID: "Team1", practiceID: "Critical Clean SBoM", levelID: "Words"},
      {teamID: "Team1", practiceID: "High Clean SBoM", levelID: "Thoughts"},
      {teamID: "Team1", practiceID: "Security Peer Review", levelID: "Unknown"},

      // Web Services
      {teamID: "Team2", practiceID: "Container-based CI", levelID: "Culture"},
      {teamID: "Team2", practiceID: "Working Agreements", levelID: "Actions"},
      {teamID: "Team2", practiceID: "Ephemeral Test Env", levelID: "Actions"},
      {teamID: "Team2", practiceID: "ADR + AVM", levelID: "Words"},
      {teamID: "Team2", practiceID: "DDoS", levelID: "Words"},
      {teamID: "Team2", practiceID: "Secure Coding", levelID: "Culture"},
      {teamID: "Team2", practiceID: "Critical Clean 1st-P", levelID: "Words"},
      {teamID: "Team2", practiceID: "High Clean 1st-P", levelID: "Thoughts"},
      {teamID: "Team2", practiceID: "Critical Clean SBoM", levelID: "Words"},
      {teamID: "Team2", practiceID: "High Clean SBoM", levelID: "Thoughts"},
      {teamID: "Team2", practiceID: "Security Peer Review", levelID: "Thoughts"},

      // Design Services
      {teamID: "Team3", practiceID: "Container-based CI", levelID: "Actions"},
      {teamID: "Team3", practiceID: "Working Agreements", levelID: "Words"},
      {teamID: "Team3", practiceID: "Ephemeral Test Env", levelID: "Words"},
      {teamID: "Team3", practiceID: "ADR + AVM", levelID: "Thoughts"},
      {teamID: "Team3", practiceID: "DDoS", levelID: "Deferral"},
      {teamID: "Team3", practiceID: "Secure Coding", levelID: "Actions"},
      {teamID: "Team3", practiceID: "Critical Clean 1st-P", levelID: "Culture"},
      {teamID: "Team3", practiceID: "High Clean 1st-P", levelID: "Culture"},
      {teamID: "Team3", practiceID: "Critical Clean SBoM", levelID: "Culture"},
      {teamID: "Team3", practiceID: "High Clean SBoM", levelID: "Culture"},
      {teamID: "Team3", practiceID: "Security Peer Review", levelID: "Thoughts"},

      // Bespoke Solutions
      {teamID: "Team4", practiceID: "Container-based CI", levelID: "Culture"},
      {teamID: "Team4", practiceID: "Working Agreements", levelID: "Words"},
      {teamID: "Team4", practiceID: "Ephemeral Test Env", levelID: "Culture"},
      {teamID: "Team4", practiceID: "ADR + AVM", levelID: "Words"},
      {teamID: "Team4", practiceID: "DDoS", levelID: "Words"},
      {teamID: "Team4", practiceID: "Secure Coding", levelID: "Culture"},
      {teamID: "Team4", practiceID: "Critical Clean 1st-P", levelID: "Culture"},
      {teamID: "Team4", practiceID: "High Clean 1st-P", levelID: "Words"},
      {teamID: "Team4", practiceID: "Critical Clean SBoM", levelID: "Culture"},
      {teamID: "Team4", practiceID: "High Clean SBoM", levelID: "Words"},
      {teamID: "Team4", practiceID: "Security Peer Review", levelID: "Actions"},
    ],
    disciplines: [
      {
        label: "Engineering Excellence",
        description: "Basic software engineering practices",
        practices: [
          {
            _entityID: "Container-based CI",
            label: "Container-based CI",
            description: "18% - Team is using a containter based continuous integration (CI) system like GitHub Actions",
          },
          {
            _entityID: "Working Agreements",
            label: "Working Agreements",
            description: "7% - Team has sprint and/or card-level working agreements, kanban entrance criteria, and/or definition of done",
          },
          {
            _entityID: "Ephemeral Test Env",
            label: "Ephemeral Test Env",
            description: "7% - Team has ephemeral test environments (per-branch, per-PR, or per-Commit) stood up instantly on demand by CI system sufficient for testing pre-PR-merge",
          },
        ]
      },
      {
        label: "Runtime Protection",
        description: "Prevents vulnerabilities from being exploited at runtime",
        practices: [
          {
            _entityID: "ADR + AVM",
            label: "ADR + AVM",
            description: "15% - Runtime appliction self protection (ADR + AVM via Contrast Protect) is used on all applications where pre-PR-merge vulnerability detection and rapid resolution is not present but may also be used on even those applications",
          },
          {
            _entityID: "DDoS",
            label: "DDoS",
            description: "5% - Distributed Denial of Service (DDoS via Cloudflare) Protection is in place for your customer facing applications",
          },
        ]
      },
      {
        label: "Training",
        practices: [
          {
            _entityID: "Secure Coding",
            label: "Secure Coding",
            description: "15% - The team has one representative that has been through secure coding training (Secure Coding or TBD, possibly Secure Code Warrior)",
          },
        ]
      },
      {
        label: "1st Party Code",
        description: "Security Analysis for Code Written (1st party, Interactive Application Security Testing (IAST) Contrast Assess, OWASP Top 10/Secure Coding top 25) Example: SQL Injection ",
        practices: [
          {
            _entityID: "Critical Clean 1st-P",
            label: "Critical Clean",
            description: "11% - For applicable applications, a tool to do security analysis tool for the code you write: - shows clean for all critical vulns - is in pipeline pre-PR-merge - Blocks merge - MTTR < 1 day",
          },
          {
            _entityID: "High Clean 1st-P",
            label: "High Clean",
            description: "4% - For applicable applications, a tool to do security analysis tool for the code you write: - shows clean for all high severity vulns - is in pipeline pre-PR-merge - Blocks merge - MTTR < 1 day",
          },
        ]
      },
      {
        label: "SBoM 3rd Party Code",
        description: "Security Analysis for Code Imported (3rd party, Software Composition Analysis (SCA),Software Bill of Materials (SBOM),  Libraries, CVEs, Open Source Security) Example: Log4Shell",
        practices: [
          {
            _entityID: "Critical Clean SBoM",
            label: "Critical Clean",
            description: "7% - For applicable applications, a tool to do security analysis tool for the code you import: - shows clean for all critical vulns - is in pipeline pre-PR-merge - Blocks merge - MTTR < 1 day",
          },
          {
            _entityID: "High Clean SBoM",
            label: "High Clean",
            description: "3% - For applicable applications, a tool to do security analysis tool for the code you import: - shows clean for all high severity vulns - is in pipeline pre-PR-merge - Blocks merge - MTTR < 1 day",
          },
        ]
      },
      {
        label: "Second Set of Eyes",
        practices: [
          {
            _entityID: "Security Peer Review",
            label: "Security Peer Review",
            description: "5% - A peer review is: - Done for each pull request (PR) - By someone with Secure Code Training",
          },
        ]
      },
    ]
  }

</script>

<Radar {...radarProps} />
