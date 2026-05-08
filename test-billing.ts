import { CloudBillingClient } from '@google-cloud/billing';
import { BudgetServiceClient } from '@google-cloud/billing-budgets';

async function test() {
  try {
    const billingClient = new CloudBillingClient();
    const projectId = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
    if (!projectId) {
      console.log("No project ID. listing all projects?");
    }
    
    // For now try to list billing accounts
    console.log("Listing billing accounts:");
    const [accounts] = await billingClient.listBillingAccounts();
    console.log("Accounts:", accounts);

    for (const acc of accounts) {
      if (acc.name) {
        console.log("Fetching budgets for account:", acc.name);
        const budgetClient = new BudgetServiceClient();
        const [budgets] = await budgetClient.listBudgets({ parent: acc.name });
        console.log("Budgets:", budgets);
      }
    }
  } catch (err) {
    console.error("Error:", err);
  }
}
test();
