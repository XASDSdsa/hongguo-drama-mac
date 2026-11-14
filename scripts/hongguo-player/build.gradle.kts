plugins { kotlin("jvm") version "2.1.20" }
kotlin { jvmToolchain(17) }
sourceSets.main { kotlin.srcDir(providers.gradleProperty("coreSource").get()) }
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.79")
    implementation("org.json:json:20240303")
    implementation("org.jsoup:jsoup:1.23.2")
}
tasks.register<Sync>("bundle") {
    dependsOn(tasks.jar)
    into(layout.buildDirectory.dir("bundle"))
    from(tasks.jar) { rename { "player.jar" } }
    from(configurations.runtimeClasspath) { into("lib") }
}
