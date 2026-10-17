/**
 * The build job's entry, bundled to `/build/job.cjs` at image build (`container/Dockerfile`). It
 * runs {@link runJob} once against the mounted workspace and prints the report on the one stdout
 * line the Galaxy parses. Kept apart from `./job.ts` so importing the job runs nothing.
 */
import { REPORT_MARKER } from '../../src/build-report';
import { runJob } from './job';

const report = runJob(process.env.WORKSPACE ?? '/workspace', {
  ontologyVersion: process.env.ONTOLOGY_VERSION || undefined,
});
console.log(REPORT_MARKER + JSON.stringify(report));
// Exit 0 whether or not steps failed: step outcomes ride the REPORT, and a non-zero
// exit would be read by the host's exec classification as the JOB itself dying
// (container-step infra failure) rather than a step outcome.
process.exit(0);
