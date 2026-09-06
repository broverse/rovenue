// HomeScreen.kt — the demonstrated flow's home screen:
//   configure (in HomeViewModel.bootstrap, on LaunchedEffect) -> identify ->
//   offerings -> paywall -> purchase -> entitlement reaction -> restore,
//   plus an on-screen event log. Mirrors the iOS example's ContentView.swift.
package dev.rovenue.example.android.ui

import android.app.Activity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import dev.rovenue.example.android.ExampleConfig
import dev.rovenue.example.android.HomeViewModel
import dev.rovenue.sdk.Paywall
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(viewModel: HomeViewModel, activity: Activity) {
    val configuring by viewModel.configuring.collectAsState()

    LaunchedEffect(Unit) { viewModel.bootstrap() }

    var activePaywall by remember { mutableStateOf<Paywall?>(null) }

    if (activePaywall != null) {
        PaywallScreen(
            paywall = activePaywall!!,
            viewModel = viewModel,
            activity = activity,
            onDismiss = { activePaywall = null },
        )
        return
    }

    Scaffold(
        topBar = { TopAppBar(title = { Text("Rovenue Example") }) },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (configuring) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        CircularProgressIndicator()
                        Text("Configuring…", modifier = Modifier.padding(top = 12.dp))
                    }
                }
            } else {
                HomeContent(
                    viewModel = viewModel,
                    activity = activity,
                    onOpenPaywall = { activePaywall = it },
                )
            }

            val busyLabel by viewModel.busyLabel.collectAsState()
            if (busyLabel != null) {
                Surface(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 16.dp),
                    shape = MaterialTheme.shapes.extraLarge,
                    tonalElevation = 4.dp,
                ) {
                    Row(
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        CircularProgressIndicator(modifier = Modifier.padding(end = 4.dp))
                        Text("$busyLabel…")
                    }
                }
            }
        }
    }
}

@Composable
private fun HomeContent(
    viewModel: HomeViewModel,
    activity: Activity,
    onOpenPaywall: (Paywall) -> Unit,
) {
    val currentUser by viewModel.currentUser.collectAsState()
    val entitlements by viewModel.entitlements.collectAsState()
    val log by viewModel.log.collectAsState()
    var appUserIdText by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()

    LazyColumn(modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        item {
            SectionTitle("Identity")
            Text("rovenueId: ${currentUser?.rovenueId ?: "loading…"}")
            Text("appUserId: ${currentUser?.appUserId ?: "(anonymous)"}")
            OutlinedTextField(
                value = appUserIdText,
                onValueChange = { appUserIdText = it },
                label = { Text("appUserId to identify") },
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                singleLine = true,
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Button(
                    onClick = {
                        viewModel.appUserIdInput = appUserIdText
                        viewModel.identify()
                    },
                    enabled = appUserIdText.trim().isNotEmpty(),
                ) { Text("Identify") }
                OutlinedButton(onClick = { viewModel.logOut() }) { Text("Log out") }
            }
            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
        }

        item {
            SectionTitle("Entitlements")
            if (entitlements.isEmpty()) {
                Text("(none)", color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                entitlements.forEach { entitlement ->
                    Column(modifier = Modifier.padding(vertical = 4.dp)) {
                        Text(entitlement.id, style = MaterialTheme.typography.titleSmall)
                        Text(
                            "active: ${entitlement.isActive} · expires: ${entitlement.expiresIso ?: "-"}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(onClick = { viewModel.refreshEntitlementsFromNetwork() }) {
                    Text("Refresh entitlements")
                }
                OutlinedButton(onClick = { viewModel.restore(activity) }) { Text("Restore purchases") }
            }
            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
        }

        item {
            SectionTitle("Products")
            if (viewModel.products.isEmpty()) {
                Text("(no offerings loaded)", color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedButton(onClick = { viewModel.loadOfferings() }) { Text("Load offerings") }
            }
            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
        }

        items(viewModel.products) { product ->
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column {
                    Text(product.displayName, style = MaterialTheme.typography.titleSmall)
                    Text(
                        product.priceString ?: product.id,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Button(onClick = { viewModel.purchase(activity, product) }) { Text("Purchase") }
            }
        }

        item {
            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
            SectionTitle("Paywall")
            Button(
                onClick = {
                    scope.launch {
                        val paywall = viewModel.resolvePaywall()
                        if (paywall != null) onOpenPaywall(paywall)
                    }
                },
            ) { Text("Open paywall (${ExampleConfig.placementIdentifier})") }
            HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
        }

        item { SectionTitle("Log") }
        items(log) { line ->
            Text(
                line,
                fontFamily = FontFamily.Monospace,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(vertical = 2.dp),
            )
        }
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.titleMedium,
        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp),
    )
}
