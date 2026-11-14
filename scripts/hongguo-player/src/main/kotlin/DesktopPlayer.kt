// SPDX-License-Identifier: GPL-3.0-only
package com.hongguotv.core

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI
import java.util.concurrent.TimeUnit
import okhttp3.Authenticator
import okhttp3.Credentials
import okhttp3.OkHttpClient
import org.json.JSONObject

/** Resolve one exact episode. Stdout is a single private JSON response to the desktop app. */
fun main(args: Array<String>) {
    var http: OkHttpClient? = null
    try {
        val id = args.singleOrNull()?.takeIf { it.matches(Regex("[0-9]{1,30}")) }
            ?: throw IllegalArgumentException("分集编号无效")
        val builder = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(12, TimeUnit.SECONDS)
            .callTimeout(18, TimeUnit.SECONDS)
            .cookieJar(MemoryCookies())
            .addInterceptor { chain ->
                val request = chain.request()
                val response = chain.proceed(request)
                // The native UI tolerates an arbitrary map entry in some legacy responses.
                // Downloads must always match the requested episode.
                if (request.url.encodedPath.contains("multi_video_model") && response.isSuccessful) {
                    val body = response.peekBody(2 * 1024 * 1024).string()
                    if (body.isNotBlank()) {
                        val data = JSONObject(body).optJSONObject("data")
                        val rows = data?.optJSONObject("video_model_data") ?: data
                        if (rows != null && rows.length() > 0 && !rows.has(id)) {
                            response.close()
                            throw IOException("片源返回的分集编号不匹配")
                        }
                    }
                }
                response
            }
        val proxyText = System.getenv("HTTPS_PROXY") ?: System.getenv("https_proxy")
        if (!proxyText.isNullOrBlank()) {
            val proxy = URI(proxyText)
            require(proxy.scheme == "http" && proxy.host != null) { "不支持的代理设置" }
            builder.proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress(proxy.host, if (proxy.port > 0) proxy.port else 80)))
            proxy.rawUserInfo?.let {
                val userInfo = proxy.userInfo.split(':', limit = 2)
                builder.proxyAuthenticator(Authenticator { _, response ->
                    if (response.request.header("Proxy-Authorization") != null) null
                    else response.request.newBuilder().header("Proxy-Authorization", Credentials.basic(userInfo[0], userInfo.getOrElse(1) { "" })).build()
                })
            }
        } else {
            builder.proxy(Proxy.NO_PROXY)
        }
        http = builder.build()
        val repository = ContentRepository(http)
        val ladder = repository.streamLadderWithCompatibility(id)
        val allowed = ladder.renditions.filter {
            it.codec.lowercase() in setOf("h264", "avc", "avc1", "hevc", "h265", "hvc1", "hev1", "bytevc1") &&
                it.quality >= 720 && (it.width == null || it.height == null || minOf(it.width, it.height) >= 720)
        }
        val selected = StreamLadder(allowed).select(1080) ?: throw IOException("本集没有可用的720p以上完整片源")
        val response = JSONObject().put("ok", true).put("vid", id)
            .put("url", selected.url).put("quality", "${selected.quality}p")
            .put("codec", selected.codec).put("width", selected.width).put("height", selected.height)
        selected.key?.let { response.put("contentKey", it.joinToString("") { byte -> "%02x".format(byte.toInt() and 255) }) }
        emit(response)
    } catch (error: Exception) {
        val message = when (error) {
            is IllegalArgumentException -> "分集编号或代理设置无效"
            is PlaybackDeviceRegistrationException -> "播放设备注册失败，请检查网络后重试"
            is EmptyPlaybackResponseException -> "播放接口返回空响应，请稍后重试"
            is java.net.SocketTimeoutException -> "播放信息请求超时，请重试"
            else -> "未取得本集可用的高清片源，请稍后重试"
        }
        emit(JSONObject().put("ok", false).put("code", error.javaClass.simpleName).put("error", message))
    } finally {
        http?.connectionPool?.evictAll()
        http?.dispatcher?.executorService?.shutdown()
    }
}

private fun emit(value: JSONObject) {
    System.out.write((value.toString() + "\n").toByteArray(Charsets.UTF_8))
    System.out.flush()
}
