#!/usr/bin/env node
/**
 * Test 15: API Gateway Route Integrity
 *
 * Confirms that every api.futarchy.fi route reaches the correct backend.
 * Diagnoses the Charts API 500 outage caused by a misrouted integration.
 */

const EC2_IP = '18.229.197.237';

async function test() {
  console.log('=== API Gateway Route Integrity ===\n');

  // 1. Check what the AWS integrations actually point to
  const { execSync } = await import('child_process');

  let integrations;
  try {
    const raw = execSync(
      `aws apigatewayv2 get-integrations --api-id b03ssv247b --region eu-north-1 --output json`,
      { encoding: 'utf-8' }
    );
    integrations = JSON.parse(raw).Items;
  } catch (e) {
    console.error('❌ Failed to fetch API Gateway integrations:', e.message);
    process.exit(1);
  }

  // Map integration IDs to URIs
  const integrationMap = {};
  for (const i of integrations) {
    integrationMap[i.IntegrationId] = {
      type: i.IntegrationType,
      uri: i.IntegrationUri,
      method: i.IntegrationMethod
    };
  }

  // 2. Fetch routes
  let routes;
  try {
    const raw = execSync(
      `aws apigatewayv2 get-routes --api-id b03ssv247b --region eu-north-1 --output json`,
      { encoding: 'utf-8' }
    );
    routes = JSON.parse(raw).Items;
  } catch (e) {
    console.error('❌ Failed to fetch API Gateway routes:', e.message);
    process.exit(1);
  }

  console.log('Route → Integration mapping:\n');

  const expected = {
    'ANY /registry/{proxy+}': { shouldContain: EC2_IP, label: 'EC2 (registry)' },
    'ANY /candles/{proxy+}':  { shouldContain: EC2_IP, label: 'EC2 (candles)' },
    'ANY /charts/{proxy+}':   { shouldContain: EC2_IP, label: 'EC2 (charts)' },
    'ANY /{proxy+}':          { shouldContain: 'lambda', label: 'Lambda (TWAP)' },
    'ANY /':                  { shouldContain: 'lambda', label: 'Lambda (TWAP)' },
  };

  let hasFailure = false;

  for (const route of routes) {
    const integId = (route.Target || '').replace('integrations/', '');
    const integ = integrationMap[integId] || { type: '???', uri: '???' };
    const exp = expected[route.RouteKey];

    let status = '⚪';
    if (exp) {
      const matches = integ.uri.toLowerCase().includes(exp.shouldContain.toLowerCase());
      status = matches ? '✅' : '❌';
      if (!matches) hasFailure = true;
    }

    console.log(`  ${status} ${route.RouteKey}`);
    console.log(`     Type: ${integ.type}`);
    console.log(`     URI:  ${integ.uri}`);
    if (exp && !integ.uri.toLowerCase().includes(exp.shouldContain.toLowerCase())) {
      console.log(`     ⚠️  EXPECTED to contain: ${exp.shouldContain} (${exp.label})`);
      console.log(`     ⚠️  THIS IS THE PROBLEM — route is pointing to the wrong backend!`);
    }
    console.log();
  }

  // 3. Live endpoint tests
  console.log('\n=== Live Endpoint Tests ===\n');

  const endpoints = [
    { url: 'https://api.futarchy.fi/health', label: 'TWAP /health' },
    { url: 'https://api.futarchy.fi/charts/warmer', label: 'Charts /warmer' },
    { url: `http://${EC2_IP}/charts/warmer`, label: 'Direct EC2 /charts/warmer (via Nginx)' },
    { url: 'http://localhost:3031/warmer', label: 'Local Charts service (port 3031)' },
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, { signal: AbortSignal.timeout(8000) });
      const icon = res.ok ? '✅' : '❌';
      console.log(`  ${icon} ${ep.label}: HTTP ${res.status}`);
    } catch (e) {
      console.log(`  ❌ ${ep.label}: ${e.message}`);
    }
  }

  // 4. Summary
  console.log('\n=== Diagnosis ===\n');
  if (hasFailure) {
    console.log('🔴 PROBLEM FOUND: One or more API Gateway routes point to the wrong backend.');
    console.log('   The /charts/ route should proxy to this EC2 server but is pointing elsewhere.');
    console.log(`   FIX: Update integration b93lu0f URI from current value to http://${EC2_IP}/charts/{proxy}`);
  } else {
    console.log('🟢 All routes correctly configured.');
  }
}

test().catch(console.error);
