import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const workflow = Bun.YAML.parse(readFileSync('.github/workflows/release.yml', 'utf8')) as any;
const jobs = workflow.jobs;
const publishSteps = JSON.stringify(jobs.publish.steps);

test('runs on version tags', () => {
    expect(workflow.on.push.tags).toEqual(['v*']);
});

test('tests on ubuntu and on an Intel Mac', () => {
    expect(jobs.test.strategy.matrix.os).toEqual(['ubuntu-latest', 'macos-15-intel']);
});

test('publish waits for the tests', () => {
    expect([jobs.publish.needs].flat()).toContain('test');
});

test('only publish can write', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(jobs.publish.permissions).toEqual({ contents: 'write' });
    expect(jobs.test.permissions).toBeUndefined();
});

test('publishes the three assets, beta as prerelease', () => {
    expect(publishSteps).toContain('dist/nucleon-sync-$VERSION.tar.gz');
    expect(publishSteps).toContain('dist/SHA256SUMS');
    expect(publishSteps).toContain('dist/install.sh');
    expect(publishSteps).toContain('--prerelease');
});

test('publish refuses a tag that is not on main', () => {
    expect(jobs.publish.steps[0].with['fetch-depth']).toBe(0);
    expect(publishSteps).toContain('git merge-base --is-ancestor \\"$GITHUB_SHA\\" origin/main');
});

test('the build gets the tag as well as the version', () => {
    expect(publishSteps).toContain('build-release.sh \\"$VERSION\\" \\"$GITHUB_REF_NAME\\"');
});
