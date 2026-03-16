# Charts API Gateway Outage Troubleshooting

## 🚨 Symptom
The `Charts API` was reported as `🔴 Unreachable` by the `futarchy-status` bot. Specifically, requests to `https://api.futarchy.fi/charts/warmer` were returning HTTP `500 Internal Server Error`, while local requests to the underlying Node service on port `3031` were succeeding with HTTP `200`.

## 🔍 Investigation Steps

1. **Verify Backend Service:** Checked the local service via `curl http://localhost:3031/warmer`. It returned an active JSON response. The charts service itself had not crashed.
2. **Nginx Proxy Verification:** `api.futarchy.fi` routes through a local Nginx reverse proxy.
   - Using `curl -H "Host: api.futarchy.fi" http://localhost/charts/warmer` returned `403 Forbidden`.
   - Inspection of `/etc/nginx/sites-enabled/api.futarchy.fi` revealed that the `/charts/` block had a hardcoded requirement for the `X-Futarchy-Secret` header, which the public status bot naturally did not possess.
3. **API Gateway Diagnosis:** Although Nginx returned `403`, external requests were returning `500`. The HTTP headers showed `apigw-requestid`, proving that traffic to `api.futarchy.fi` routes through AWS API Gateway *before* hitting Nginx.
   - We used the AWS CLI to inspect the API Gateway domain mappings.
   - We found that `api.futarchy.fi` mapped entirely to the `futarchy-twap-api` API deployment.
4. **Integration Route Bug:** Upon inspecting the `futarchy-twap-api` API Gateway routes (using `aws apigatewayv2 get-routes` and `aws apigatewayv2 get-integrations`):
   - The `/registry/{proxy+}` route correctly pointed to `http://18.229.197.237/registry/{proxy}`.
   - The `/candles/{proxy+}` route correctly pointed to `http://18.229.197.237/candles/{proxy}`.
   - 🔴 **The `/charts/{proxy+}` route incorrectly pointed to `http://stag.api.tickspread.com/{proxy}`.**

This proved that all charts API requests were being sent to an incorrect, offline staging server by AWS API Gateway, resulting in the `500` error. The `403` error from Nginx was a secondary, hidden issue that would have blocked requests even if API Gateway routed them correctly.

## 🛠️ Resolution & Fix

1. **Test Script Created:** Built `tests/15-api-gateway-routes.js` to automatically verify every API Gateway route against its integration URI to catch wrong backends.
2. **Fixed Nginx Config:** Removed the `X-Futarchy-Secret` limitation in the `/charts/` location block within `/etc/nginx/sites-enabled/api.futarchy.fi` and ran `sudo systemctl reload nginx`.
3. **Fixed AWS API Gateway:** Ran the AWS CLI command to update the misconfigured integration to point to the correct EC2 instance:
   ```bash
   aws apigatewayv2 update-integration \
     --api-id b03ssv247b \
     --integration-id b93lu0f \
     --integration-uri "http://18.229.197.237/charts/{proxy}" \
     --region eu-north-1
   ```
4. **Verification:** Rerunning the test script now reports `✅ All routes correctly configured` and live endpoint checks on `https://api.futarchy.fi/charts/warmer` immediately succeed with `HTTP 200`. The status bot now reflects `🟢 Charts API — Serving unified charts and caching correctly`.
